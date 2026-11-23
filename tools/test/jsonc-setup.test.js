"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { mergeEntries, deepEqual } = require("../lib/jsonc.js");
const { setup, TASK_ENTRIES, DEBUG_ENTRIES, assertOutsideGradleProject } = require("../lib/setup.js");

test("mergeEntries adds entries and preserves foreign ones plus comments", () => {
  const text = [
    "// my personal tasks",
    "[",
    "  { // keep me",
    '    "label": "Cargo check",',
    '    "command": "cargo"',
    "  }",
    "]",
    "",
  ].join("\n");
  const result = mergeEntries(text, TASK_ENTRIES);
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.changed);
  assert.strictEqual(result.added.length, TASK_ENTRIES.length);

  const parsed = JSON.parse(result.text.replace(/\/\/.*$/gm, ""));
  assert.strictEqual(parsed[0].label, "Cargo check"); // foreign entry untouched at index 0
  assert.ok(result.text.includes("// my personal tasks"));
  assert.ok(result.text.includes("// keep me"));
  for (const entry of TASK_ENTRIES) {
    const hit = parsed.find((t) => t.label === entry.label);
    assert.deepStrictEqual(hit, entry);
  }
});

test("mergeEntries round-trip is byte-idempotent", () => {
  const first = mergeEntries("[\n]\n", TASK_ENTRIES);
  assert.ok(first.ok);
  const second = mergeEntries(first.text, TASK_ENTRIES);
  assert.ok(second.ok);
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.text, first.text);
});

test("mergeEntries reports conflict on same label different content and mutates nothing", () => {
  const text = '[\n  { "label": "Android: Build", "command": "something-else" }\n]\n';
  const result = mergeEntries(text, TASK_ENTRIES);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /already exists with different contents/);
});

test("mergeEntries rejects malformed JSONC and wrong shapes", () => {
  assert.strictEqual(mergeEntries("{oops", []).ok, false);
  assert.strictEqual(mergeEntries('{"tasks": {}}', TASK_ENTRIES).ok, false);
  assert.strictEqual(mergeEntries('"string"', TASK_ENTRIES).ok, false);
});

test("mergeEntries supports the object-shaped tasks.json and debug.json list shape", () => {
  const tasks = mergeEntries('{\n  "version": "2.0.0"\n}\n', TASK_ENTRIES);
  assert.ok(tasks.ok);
  const parsed = JSON.parse(tasks.text);
  assert.strictEqual(parsed.version, "2.0.0");
  assert.strictEqual(parsed.tasks.length, TASK_ENTRIES.length);

  const debug = mergeEntries("[]\n", DEBUG_ENTRIES);
  assert.ok(debug.ok);
  assert.deepStrictEqual(JSON.parse(debug.text), DEBUG_ENTRIES);
});

test("deepEqual is structural, not reference", () => {
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!deepEqual([1], ["1"]));
});

test("setup creates both files in an empty config dir and re-runs unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-android-setup-"));
  try {
    const logs = [];
    const log = (m) => logs.push(m);
    assert.strictEqual(await setup({ configDir: dir, log }), 0);
    assert.ok(fs.existsSync(path.join(dir, "tasks.json")));
    assert.ok(fs.existsSync(path.join(dir, "debug.json")));

    const tasks1 = fs.readFileSync(path.join(dir, "tasks.json"), "utf8");
    const logs2 = [];
    assert.strictEqual(await setup({ configDir: dir, log: (m) => logs2.push(m) }), 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"), tasks1);
    assert.ok(logs2.some((l) => l.includes("already configured")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup refuses relative config dirs and Gradle-nested config dirs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-android-setup-"));
  try {
    const logs = [];
    const log = (m) => logs.push(m);
    assert.strictEqual(await setup({ configDir: "relative/dir", log }), 1);

    // fake Gradle root; the config dir sits inside it
    fs.writeFileSync(path.join(dir, "settings.gradle"), "");
    fs.writeFileSync(path.join(dir, "gradlew.bat"), "");
    const nested = path.join(dir, "config");
    fs.mkdirSync(nested);
    assert.ok(assertOutsideGradleProject(nested));
    logs.length = 0;
    assert.strictEqual(await setup({ configDir: nested, log }), 1);
    assert.ok(logs.some((l) => l.includes("resolves inside the Gradle project")));

    // a conflict in an existing file leaves both files untouched
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "zed-android-setup-"));
    try {
      fs.writeFileSync(
        path.join(dir2, "debug.json"),
        '[\n  { "label": "Android: Debug", "adapter": "Other", "request": "attach" }\n]\n',
      );
      const tasksBefore = fs.existsSync(path.join(dir2, "tasks.json"));
      logs.length = 0;
      assert.strictEqual(await setup({ configDir: dir2, log }), 1);
      assert.ok(logs.some((l) => l.includes("nothing was changed")));
      assert.strictEqual(fs.existsSync(path.join(dir2, "tasks.json")), tasksBefore);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
