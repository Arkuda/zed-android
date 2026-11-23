#!/usr/bin/env node
// Drives `zed-android select` with scripted menu answers (fake TTY) so the
// multi-app fixture matrix can run without an interactive terminal.
// Usage: node scripts/fixture-matrix.js --root <gradle-root> [--state <dir>]
//        --answers 2,3 [--expect :wear:app|stagingDebug|example.wear.staging]
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { PassThrough } = require("stream");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const root = arg("root");
const state = arg("state");
const answers = (arg("answers") || "").split(",").filter((s) => s !== "");
const expect = arg("expect"); // module|variant|applicationId
const cmd = arg("cmd") || "select"; // select | run | build
if (!root) {
  console.error("usage: fixture-matrix.js --root R [--state S] --answers a,b [--expect m|v|app]");
  process.exit(2);
}
if (state) process.env.ZED_ANDROID_STATE_DIR = state;

const stdin = new PassThrough();
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
process.stdin.isTTY = true;

let queue = answers.slice();
const rawWrite = process.stdout.write.bind(process.stdout);
const transcript = [];
function feed() {
  if (queue.length === 0) return;
  const a = queue.shift();
  setTimeout(() => stdin.write(`${a}\n`), 50);
}
process.stdout.write = function (chunk, enc, cb) {
  const s = String(chunk);
  transcript.push(s);
  if (/> $/.test(s)) feed();
  return rawWrite(chunk, enc, cb);
};

const { main } = require("../lib/cli.js");
main([cmd]).then((code) => {
  stdin.end();
  const out = transcript.join("");
  if (expect && cmd === "select") {
    const [mod, variant, appId] = expect.split("|");
    const hash = require("../lib/paths.js").rootHash ? require("../lib/paths.js").rootHash(root) : null;
    const stateDir = process.env.ZED_ANDROID_STATE_DIR || path.join(os.homedir(), "AppData", "Local", "zed-android");
    // locate target.json by scanning projects/* for module+variant match
    let found = null;
    const proots = path.join(stateDir, "projects");
    if (fs.existsSync(proots)) {
      for (const d of fs.readdirSync(proots)) {
        const f = path.join(proots, d, "target.json");
        if (!fs.existsSync(f)) continue;
        const t = JSON.parse(fs.readFileSync(f, "utf8"));
        if (t.module === mod && t.variant === variant && t.applicationId === appId) found = { dir: d, file: f };
      }
    }
    if (!found) {
      rawWrite(`FAIL: no target.json matching ${expect} under ${proots}\n`);
      process.exit(1);
    }
    rawWrite(`PASS: target.json ${found.dir} -> ${JSON.stringify(JSON.parse(fs.readFileSync(found.file, "utf8")))}\n`);
  }
  rawWrite(`MATRIX-EXIT ${code}\n`);
  const ok = code === 0 && (cmd !== "select" || out.includes("selected"));
  process.exit(ok ? 0 : 1);
});
