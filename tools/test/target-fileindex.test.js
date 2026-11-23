"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// isolate all state writes into a temp profile before paths.js resolves anything
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "zed-android-state-"));
process.env.ZED_ANDROID_STATE_DIR = STATE;

const { groupApps, samePair, saveTarget, updateTargetExtras } = require("../lib/target.js");
const { readJsonFile, targetFile, canonicalRoot, projectHash } = require("../lib/paths.js");
const { FileIndex } = require("../lib/fileindex.js");

test("groupApps groups by module and sorts variants", () => {
  const apps = groupApps([
    { module: ":wear", variant: "release", applicationId: "a.wear" },
    { module: ":phone", variant: "debug", applicationId: "a.phone", debuggable: true },
    { module: ":phone", variant: "stagingDebug", applicationId: "a.phone.staging", debuggable: true },
  ]);
  assert.deepStrictEqual([...apps.keys()], [":wear", ":phone"]);
  assert.deepStrictEqual(apps.get(":phone").map((v) => v.variant), ["debug", "stagingDebug"]);
});

test("samePair requires exact module+variant+applicationId", () => {
  const a = { module: ":app", variant: "debug", applicationId: "x.y" };
  assert.ok(samePair(a, { ...a }));
  assert.ok(!samePair(a, { ...a, applicationId: "x.y.staging" }));
});

const LAUNCHER_CATEGORY = "android.intent.category.LAUNCHER";

test("saveTarget keeps launcher/process extras only for the exact same pair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zed-android-proj-"));
  try {
    const logs = [];
    const log = (m) => logs.push(m);
    const saved = {
      module: ":app",
      variant: "debug",
      applicationId: "x.y",
      processName: "x.y:remote",
      component: { component: "x.y/.MainActivity", category: LAUNCHER_CATEGORY },
    };
    saveTarget(root, saved, { module: ":app", variant: "debug", applicationId: "x.y" }, log);
    let stored = readJsonFile(targetFile(root)).value;
    assert.strictEqual(stored.processName, "x.y:remote");
    assert.deepStrictEqual(stored.component, saved.component);

    // different pair resets the extras
    saveTarget(root, saved, { module: ":app", variant: "release", applicationId: "x.y" }, log);
    stored = readJsonFile(targetFile(root)).value;
    assert.strictEqual(stored.processName, undefined);
    assert.strictEqual(stored.component, undefined);
    assert.ok(logs.some((m) => m.includes("launcher and process settings reset")));

    updateTargetExtras(root, { component: { component: "x.y/.Main", category: "android.intent.category.LAUNCHER" } });
    stored = readJsonFile(targetFile(root)).value;
    assert.strictEqual(stored.variant, "release"); // extras merge keeps the pair
    assert.strictEqual(stored.component.component, "x.y/.Main");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonicalRoot is stable across spelling; hash keys state per project", () => {
  const root = process.cwd();
  assert.strictEqual(projectHash(root), projectHash(`${root}${path.sep === "\\" ? "\\" : "/"}`));
  const h = projectHash(root);
  assert.match(h, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- FileIndex

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-android-index-"));
  const javaRoot = path.join(dir, "java-src");
  const ktRoot = path.join(dir, "kt-src");
  fs.mkdirSync(path.join(javaRoot, "dev", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(ktRoot, "dev", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(ktRoot, "dev", "pkg", "MainActivity.kt"), "class MainActivity\n");
  fs.writeFileSync(path.join(ktRoot, "dev", "pkg", "Probe.kt"), "fun probe()\n"); // top-level only
  fs.writeFileSync(path.join(javaRoot, "dev", "pkg", "Helper.java"), "class Helper\n");
  return { dir, javaRoot, ktRoot };
}

test("FileIndex.candidates maps sources to JVM type candidates", () => {
  const { dir, javaRoot, ktRoot } = makeFixture();
  try {
    const index = new FileIndex({ javaSources: [javaRoot], kotlinSources: [ktRoot] });

    const kt = index.candidates(path.join(ktRoot, "dev", "pkg", "MainActivity.kt"));
    assert.deepStrictEqual(kt.qtypes, ["dev/pkg/MainActivity", "dev/pkg/MainActivityKt"]);
    assert.strictEqual(kt.srcfpn, "/dev/pkg/MainActivity.java");

    const java = index.candidates(path.join(javaRoot, "dev", "pkg", "Helper.java"));
    assert.deepStrictEqual(java.qtypes, ["dev/pkg/Helper"]);

    // foreign file types and outside-root paths are rejected
    assert.strictEqual(index.candidates(path.join(ktRoot, "dev", "pkg", "res.xml")), null);
    assert.strictEqual(index.candidates(path.join(dir, "stray.kt")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FileIndex maps lowercase-named Kotlin files to capitalised facade classes", () => {
  // answer.kt compiles top-level funs into example/wear/AnswerKt (capital A).
  const { dir, javaRoot, ktRoot } = makeFixture();
  try {
    fs.writeFileSync(path.join(ktRoot, "dev", "pkg", "answer.kt"), "package dev.pkg\nfun answer(x: Int) = x + 1\n");
    const index = new FileIndex({ javaSources: [javaRoot], kotlinSources: [ktRoot] });
    const kt = index.candidates(path.join(ktRoot, "dev", "pkg", "answer.kt"));
    assert.deepStrictEqual(kt.qtypes, ["dev/pkg/answer", "dev/pkg/answerKt", "dev/pkg/AnswerKt"]);
    assert.strictEqual(index.sourceFor("Ldev/pkg/AnswerKt;"), path.join(ktRoot, "dev", "pkg", "answer.kt"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FileIndex.sourceFor resolves signatures back to files (Kt facade + inner classes)", () => {
  const { dir, javaRoot, ktRoot } = makeFixture();
  try {
    const index = new FileIndex({
      javaSources: [javaRoot],
      kotlinSources: [ktRoot],
      runtimeProjectDeps: [{ path: ":lib", variant: "debug", roots: [javaRoot] }], // dedup check
    });
    assert.strictEqual(
      index.sourceFor("Ldev/pkg/MainActivity;"),
      path.join(ktRoot, "dev", "pkg", "MainActivity.kt"),
    );
    // ProbeKt (top-level facade) falls back to Probe.kt
    assert.strictEqual(index.sourceFor("Ldev/pkg/ProbeKt;"), path.join(ktRoot, "dev", "pkg", "Probe.kt"));
    // inner/anonymous classes resolve through the outer file
    assert.strictEqual(
      index.sourceFor("Ldev/pkg/MainActivity$1;"),
      path.join(ktRoot, "dev", "pkg", "MainActivity.kt"),
    );
    assert.strictEqual(index.sourceFor("Ldev/pkg/Helper;"), path.join(javaRoot, "dev", "pkg", "Helper.java"));
    // framework classes and junk have no source
    assert.strictEqual(index.sourceFor("Ljava/lang/String;"), null);
    assert.strictEqual(index.sourceFor(null), null);

    // deleted files are not returned (existence checked per call)
    fs.rmSync(path.join(ktRoot, "dev", "pkg", "Probe.kt"));
    assert.strictEqual(index.sourceFor("Ldev/pkg/ProbeKt;"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (process.platform === "win32") {
  test("FileIndex tolerates drive-letter case differences on Windows", () => {
    const { dir, ktRoot } = makeFixture();
    try {
      const index = new FileIndex({ kotlinSources: [ktRoot] });
      const lower = path.join(ktRoot.replace(/^([A-Z]):/, "$1:"), "dev", "pkg", "MainActivity.kt");
      const spelled = `${lower[0].toLowerCase()}${lower.slice(1)}`;
      assert.ok(index.candidates(spelled));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
