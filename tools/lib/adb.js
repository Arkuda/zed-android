"use strict";

// Thin adb layer. Every device-touching call goes through one serial so we
// never act on the wrong target when several are attached.

const crossSpawn = require("cross-spawn");

/** Run an executable with an argv array (never a shell string). */
function run(exePath, args, { timeoutMs = 30_000, env, cwd } = {}) {
  return new Promise((resolve) => {
    const child = crossSpawn(exePath, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        stderr += `\ntimed out after ${timeoutMs} ms`;
        child.kill();
        finish(-2);
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

function adb(adbExe, serial, args, opts) {
  const prefix = serial ? ["-s", serial] : [];
  return run(adbExe, [...prefix, ...args], opts);
}

/** Start a detached GUI process whose output goes to an already-open log fd. */
function spawnDetached(exePath, args, logFd) {
  const child = crossSpawn(exePath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child;
}

/** `adb devices -l` -> [{serial,state,model}] */
async function listDevices(adbExe) {
  const { code, stdout, stderr } = await run(adbExe, ["devices", "-l"]);
  if (code !== 0) {
    throw new Error(`adb devices failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }
  const devices = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^List of devices attached/.test(line) || /^\*/.test(line)) continue;
    const [serial, state = "", ...rest] = line.split(/\s+/);
    if (!state) continue;
    const model = /model:(\S+)/.exec(line)?.[1] ?? null;
    devices.push({ serial, state, model });
  }
  return devices;
}

async function emuAvdName(adbExe, serial) {
  const { code, stdout } = await adb(adbExe, serial, ["emu", "avd", "name"]);
  if (code !== 0) return null;
  const first = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "";
  // Some builds echo a trailing OK line; never treat OK as the name.
  if (!first || first === "OK" || first.startsWith("error") || first.startsWith("emu:")) return null;
  return first;
}

async function getprop(adbExe, serial, prop) {
  const { code, stdout } = await adb(adbExe, serial, ["shell", "getprop", prop]);
  if (code !== 0) return "";
  return stdout.trim();
}

async function pidof(adbExe, serial, packageName) {
  const { code, stdout } = await adb(adbExe, serial, ["shell", "pidof", packageName]);
  if (code !== 0) return [];
  return stdout
    .trim()
    .split(/\s+/)
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isFinite(v));
}

/** Sample `adb jdwp` briefly; resolve true once pid appears. */
function jdwpHasPid(adbExe, serial, pid, budgetMs = 5_000) {
  return new Promise((resolve) => {
    const proc = crossSpawn(adbExe, ["-s", serial, "jdwp"], { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    const hasPid = () => buffer.split(/\r?\n/).some((line) => line.trim() === String(pid));
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      resolve(value);
    };
    proc.stdout.on("data", (d) => {
      buffer += d;
      if (hasPid()) settle(true);
    });
    proc.on("error", () => settle(false));
    proc.on("close", () => settle(hasPid()));
    const timer = setTimeout(() => settle(hasPid()), budgetMs);
    timer.unref?.();
  });
}

async function forward(adbExe, serial, local, remote) {
  const { code, stdout, stderr } = await adb(adbExe, serial, ["forward", local, remote]);
  if (code !== 0) {
    throw new Error(`adb forward ${local} ${remote} failed: ${(stderr || stdout).trim()}`);
  }
  return stdout.trim(); // for tcp:0 the assigned port
}

async function forwardRemove(adbExe, serial, local) {
  await adb(adbExe, serial, ["forward", "--remove", local]);
}

async function shell(adbExe, serial, args, opts) {
  return adb(adbExe, serial, ["shell", ...args], opts);
}

module.exports = {
  run,
  adb,
  spawnDetached,
  listDevices,
  emuAvdName,
  getprop,
  pidof,
  jdwpHasPid,
  forward,
  forwardRemove,
  shell,
};
