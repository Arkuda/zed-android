"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { parseJavaProperties } = require("../lib/sdk.js");
const { parseAvdList } = require("../lib/emulator.js");
const { extractComponents, pickCategory, LAUNCHER, LEANBACK } = require("../lib/launcher.js");
const { taskPath } = require("../lib/gradle.js");

test("parseJavaProperties unescapes sdk.dir the way Gradle writes it", () => {
  const props = parseJavaProperties("sdk.dir=E\\:\\\\android_sdk\n");
  assert.strictEqual(props["sdk.dir"], "E:\\android_sdk"); // E\:\android_sdk -> E:\android_sdk
});

test("parseJavaProperties handles comments, blank lines, separators, continuations", () => {
  const text = [
    "# comment line",
    "! bang comment",
    "",
    "plain.key = spaced value ",
    "colon\\:key:value",
    "no.value",
    "multi=line1\\",
    "line2",
    "unicode=caf\\u00e9",
  ].join("\n");
  const props = parseJavaProperties(text);
  assert.strictEqual(props["plain.key"], "spaced value");
  assert.strictEqual(props["colon:key"], "value");
  assert.strictEqual(props["no.value"], "");
  assert.strictEqual(props["multi"], "line1line2");
  assert.strictEqual(props["unicode"], "café");
});

test("parseAvdList keeps only AVD names", () => {
  const stdout = [
    "INFO:   Android Studio Instance 0 (started 47826ms ago)",
    "",
    "WARNING: something about headers",
    "INFO         | emulator: now launching...",
    "Pixel_9",
    "ludoavd",
    "  spaced-avd  ",
  ].join("\n");
  assert.deepStrictEqual(parseAvdList(stdout), ["Pixel_9", "ludoavd", "spaced-avd"]);
});

test("extractComponents keeps only component lines", () => {
  const stdout = [
    "2 activities found:",
    "",
    "  dev.phosphor.launcher/.MainActivity",
    "com.example.app/com.example.app.Settings",
    "No activities found",
    "",
    "Install path: /data/app/base.apk", // contains / but not a component shape
    "package:com.example.other",
  ].join("\n");
  assert.deepStrictEqual(extractComponents(stdout), [
    "dev.phosphor.launcher/.MainActivity",
    "com.example.app/com.example.app.Settings",
  ]);
});

test("pickCategory prefers plain LAUNCHER over LEANBACK", () => {
  assert.strictEqual(pickCategory({ categories: [LEANBACK, LAUNCHER] }), LAUNCHER);
  assert.strictEqual(pickCategory({ categories: [LEANBACK] }), LEANBACK);
});

test("taskPath builds exact Gradle task names (root module included)", () => {
  assert.strictEqual(taskPath(":app", "assemble", "debug"), ":app:assembleDebug");
  assert.strictEqual(taskPath(":wear:app", "install", "stagingRelease"), ":wear:app:installStagingRelease");
  assert.strictEqual(taskPath(":", "assemble", "release"), ":assembleRelease"); // no ::
});
