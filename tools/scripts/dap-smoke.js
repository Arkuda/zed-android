"use strict";

// Headless end-to-end smoke for `zed-android dap`: spawns the real adapter
// against a booted emulator + the Phosphor app and drives the exact DAP
// sequence Zed's debugger sends. Not part of `npm test` (needs a device).
//
//   node scripts/dap-smoke.js [projectRoot]
//
// Checks: launch handshake, breakpoint at the FrameLayout(this) line of
// MainActivity.onCreate, stack frames resolve to real .kt files, locals are
// readable, step-over lands on the Dock(this) line, continue runs, disconnect
// removes only our adb forward (a control forward must survive).

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(process.argv[2] ?? process.cwd());
const ADB = process.env.ADB_EXE || "adb";
const BIN = path.join(__dirname, "..", "bin", "zed-android.cjs");
// Defaults target phosphor_impl; fixtures override via SMOKE_BP_FILE (slash path
// under ROOT), SMOKE_BP_PATTERN, SMOKE_NEXT_PATTERN, SMOKE_EXPECT_LOCALS, SMOKE_APP_ID.
const MAIN_KT = process.env.SMOKE_BP_FILE
  ? path.join(ROOT, ...process.env.SMOKE_BP_FILE.split("/"))
  : path.join(ROOT, "app", "src", "main", "java", "dev", "phosphor", "launcher", "MainActivity.kt");
const APP_ID = process.env.SMOKE_APP_ID || "dev.phosphor.launcher";

function findLine(file, pattern) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const idx = lines.findIndex((l) => pattern.test(l));
  if (idx < 0) throw new Error(`${file} has no line matching ${pattern}`);
  return idx + 1; // DAP lines are 1-based
}

const BREAK_LINE = findLine(MAIN_KT, process.env.SMOKE_BP_PATTERN ? new RegExp(process.env.SMOKE_BP_PATTERN) : /frame\s*=\s*FrameLayout\(this\)/);
const NEXT_LINE = process.env.SMOKE_NEXT_PATTERN
  ? findLine(MAIN_KT, new RegExp(process.env.SMOKE_NEXT_PATTERN))
  : process.env.SMOKE_BP_FILE
    ? null
    : findLine(MAIN_KT, /dock\s*=\s*Dock\(this\)/);

let seq = 0;
const pending = new Map(); // request seq -> {resolve, command}
let stdoutBuf = Buffer.alloc(0);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${what}`);
  if (!ok) failures++;
}

function sendProc(child, msg) {
  const json = JSON.stringify(msg);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function request(child, command, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const rseq = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(rseq)) reject(new Error(`no response to ${command} (seq ${rseq}) within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(rseq, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, command });
    sendProc(child, { seq: rseq, type: "request", command, arguments: args ?? {} });
  });
}

// linear event bus: waiters consume matching events first, leftovers queue
const bus = [];
const waiters = [];
function onEvent(e) {
  const idx = waiters.findIndex((w) => w.type === e.event && (!w.pred || w.pred(e.body)));
  if (idx >= 0) {
    const w = waiters.splice(idx, 1)[0];
    clearTimeout(w.timer);
    w.resolve(e.body);
  } else {
    bus.push(e);
  }
}
function waitEvent(type, pred, timeoutMs) {
  const idx = bus.findIndex((e) => e.event === type && (!pred || pred(e.body)));
  if (idx >= 0) return Promise.resolve(bus.splice(idx, 1)[0].body);
  return new Promise((resolve, reject) => {
    waiters.push({ type, pred, resolve, reject, timer: setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs) });
  });
}

function parseStream(child, onData) {
  child.stdout.on("data", (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    for (;;) {
      const sep = stdoutBuf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = stdoutBuf.subarray(0, sep).toString();
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) throw new Error(`bad DAP header: ${header}`);
      const len = Number(m[1]);
      if (stdoutBuf.length < sep + 4 + len) return;
      const body = JSON.parse(stdoutBuf.subarray(sep + 4, sep + 4 + len).toString());
      stdoutBuf = stdoutBuf.subarray(sep + 4 + len);
      onData(body);
    }
  });
}

function adb(argsArr) {
  return spawnSync(ADB, argsArr, { encoding: "utf8" });
}

async function main() {
  // control forward owned by someone else; our teardown must not kill it
  adb(["forward", "tcp:12345", "tcp:9999"]);

  const child = spawn(process.execPath, [BIN, "dap"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  parseStream(child, (msg) => {
    if (msg.type === "event") return onEvent(msg);
    const p = pending.get(msg.request_seq);
    if (!p) return;
    pending.delete(msg.request_seq);
    if (msg.success === false) {
      p.reject(new Error(`${p.command} failed: ${msg.message ?? JSON.stringify(msg.body)}`));
    } else {
      p.resolve(msg.body ?? {});
    }
  });

  const init = await request(child, "initialize", { adapterID: "Android", pathFormat: "path", columnsStartAt1: false });
  check(init.supportsConfigurationDoneRequest === true, "capabilities: configurationDone");
  check(init.supportsExceptionInfoRequest === true, "capabilities: exceptionInfo");
  check(init.supportsEvaluateForHovers === undefined || init.supportsEvaluateForHovers === false, "capabilities: no fake evaluator");

  const launchPromise = request(child, "launch", { request: "launch" }).then((body) => {
    check(true, `launch response arrived (${JSON.stringify(body)})`);
    return body;
  });

  // Zed's contract: configure breakpoints only after the initialized event
  await waitEvent("initialized", null, 180_000);
  let stopped;
  if (process.env.SMOKE_DELAY_BP) {
    // issue #139 mode: app runs first, handler executes BEFORE the breakpoint
    // exists; then set it on the already-executed class and click again.
    await request(child, "setExceptionBreakpoints", { filters: ["uncaught"] });
    const done0 = request(child, "configurationDone", {});
    await launchPromise;
    await done0;
    await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_DELAY_BP) * 1000));
    const [tx, ty] = (process.env.SMOKE_TAP || "").split(",").map((s) => s.trim());
    const tap1 = adb(["shell", "input", "tap", tx, ty]);
    check(tap1.status === 0, "pre-breakpoint click ran without stopping");
    await new Promise((r) => setTimeout(r, 1500)); // handler definitely executed
    const bpLate = await request(child, "setBreakpoints", {
      source: { path: MAIN_KT },
      breakpoints: [{ line: BREAK_LINE }],
    });
    check(bpLate.breakpoints?.[0]?.verified === true, `breakpoint verified on already-loaded class (${JSON.stringify(bpLate.breakpoints?.[0])})`);
    const stopP = waitEvent("stopped", (b) => b.reason === "breakpoint", 30_000);
    const tap2 = adb(["shell", "input", "tap", tx, ty]);
    check(tap2.status === 0, "post-breakpoint click sent");
    stopped = await stopP;
  } else {
    const bps = await request(child, "setBreakpoints", {
      source: { path: MAIN_KT },
      breakpoints: [{ line: BREAK_LINE }],
    });
    // before the class loads the adapter honestly reports unverified-with-reason;
    // either that or verified-registered is acceptable here (the hit check below
    // proves registration)
    const bp0 = bps.breakpoints?.[0];
    check(
      bp0 && (bp0.verified === true || /hasn.t loaded/.test(bp0.message ?? "")),
      `breakpoint registered at MainActivity.kt:${BREAK_LINE} (${JSON.stringify(bp0)})`,
    );
    await request(child, "setExceptionBreakpoints", { filters: ["uncaught"] });
    const donePromise = request(child, "configurationDone", {});
    await launchPromise;
    await donePromise;
    stopped = await waitEvent("stopped", (b) => b.reason === "breakpoint", 60_000);
  }
  check(stopped.threadId !== undefined, `stopped at breakpoint (thread ${stopped.threadId})`);

  const st = await request(child, "stackTrace", { threadId: stopped.threadId });
  const top = st.stackFrames?.[0];
  check(top && top.source?.path === MAIN_KT, `top frame source is the real Kotlin file (${top?.source?.path})`);
  check(top?.line === BREAK_LINE, `top frame line ${top?.line} == ${BREAK_LINE}`);

  const scopes = await request(child, "scopes", { frameId: top.id });
  const local = scopes.scopes.find((s) => s.name === "Local");
  check(!!local, "Local scope present");
  const vars = await request(child, "variables", { variablesReference: local.variablesReference });
  const names = (vars.variables ?? []).map((v) => v.name);
  check(Array.isArray(vars.variables) && vars.variables.length > 0, `locals readable: ${names.join(", ")}`);
  for (const want of (process.env.SMOKE_EXPECT_LOCALS || "").split(",").filter(Boolean)) {
    const [wname, wval] = want.split("=").map((s) => s.trim());
    // JDWP exposes captured lambda locals with a leading '$' ($taps); match either spelling
    const v = (vars.variables ?? []).find((x) => x.name === wname || x.name.replace(/^\$/, "") === wname);
    check(!!v && (!wval || String(v.value).includes(wval)), `local '${want.trim()}' visible${v ? ` = ${v.value}` : " (absent)"}`);
  }

  const stepPromise = waitEvent("stopped", (b) => b.reason === "step", 30_000);
  await request(child, "next", { threadId: stopped.threadId });
  const stepped = await stepPromise;
  check(stepped.threadId === stopped.threadId, "step-over stops the same thread");
  if (NEXT_LINE !== null) {
    const st2 = await request(child, "stackTrace", { threadId: stepped.threadId });
    check(st2.stackFrames[0]?.line === NEXT_LINE, `step-over landed on line ${st2.stackFrames[0]?.line} (expected ${NEXT_LINE})`);
  }

  console.log("PHASE: continue");
  await request(child, "continue", { threadId: stepped.threadId });
  await new Promise((r) => setTimeout(r, 3_000)); // let the app actually run

  if (process.env.SMOKE_UNSET_BP) {
    // issue #139 tail: remove the breakpoint; the next click must pass through
    const cleared = await request(child, "setBreakpoints", { source: { path: MAIN_KT }, breakpoints: [] });
    check((cleared.breakpoints ?? []).length === 0, "breakpoint list cleared");
    const [ux, uy] = (process.env.SMOKE_TAP || "").split(",").map((s) => s.trim());
    const before = bus.length;
    adb(["shell", "input", "tap", ux, uy]);
    await new Promise((r) => setTimeout(r, 4_000));
    const extraStops = bus.filter((e) => e.event === "stopped" && (e.body ?? {}).reason === "breakpoint").length;
    check(extraStops <= before, `click after breakpoint removal did not stop (new stopped events: ${extraStops - before})`);
  }

  console.log("PHASE: disconnect");
  await request(child, "disconnect", {}, 20_000);
  console.log("PHASE: disconnected, closing stdin for adapter exit");
  child.stdin.end(); // the DAP server exits when its client hangs up
  const code = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => resolve("stuck"), 10_000)),
  ]);
  check(code === 0 || code === null, `adapter exited (${code})`);

  const fw = adb(["forward", "--list"]).stdout;
  console.log(`forward list after session:\n${fw.trim() || "(empty)"}`);
  check(/tcp:12345\s+tcp:9999/.test(fw), "control forward survived");
  check(!/jdwp:/.test(fw), "no jdwp forward left behind");
  const pid = adb(["shell", "pidof", APP_ID]).stdout.trim();
  check(!pid, `app stopped after disconnect (pidof=${pid || "none"})`);

  adb(["forward", "--remove", "tcp:12345"]);
  child.kill();
  process.exitCode = failures ? 1 : 0;
  console.log(failures ? `${failures} FAILURES` : "ALL CHECKS PASSED");
}

main().catch((err) => {
  console.error(`SMOKE ABORTED: ${err?.message ?? err}`);
  adb(["forward", "--remove", "tcp:12345"]);
  process.exitCode = 1;
});
