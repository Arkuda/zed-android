"use strict";

// AVD discovery and start. `emulator -list-avds` is the only source of AVD
// names (no ~/.android walking), and its diagnostic noise never reaches the
// menu. A started emulator must outlive the task that started it.

const fs = require("node:fs");
const path = require("node:path");

const adbLib = require("./adb.js");
const { menu, Cancelled } = require("./picker.js");
const { adbPath, emulatorPath, exe } = require("./sdk.js");
const { deviceFile, stateDir, writeJson } = require("./paths.js");

const BOOT_TIMEOUT_MS = 180_000;

/** Keep only plausible AVD names; drop `INFO | ...` style noise lines. */
function parseAvdList(stdout) {
  const names = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(INFO|WARNING|WARN|ERROR|FATAL|DEBUG)\b/.test(line)) continue;
    if (/\s\|\s/.test(line)) continue; // "level | message" diagnostics
    names.push(line);
  }
  return names;
}

async function listAvds(sdkDir) {
  const emulatorExe = emulatorPath(sdkDir);
  if (!fs.existsSync(emulatorExe)) {
    throw new Error(
      `emulator not found: ${emulatorExe} (checked under SDK ${sdkDir}); install the "Android Emulator" SDK package`,
    );
  }
  const { code, stdout, stderr } = await adbLib.run(emulatorExe, ["-list-avds"], { timeoutMs: 60_000 });
  if (code !== 0) {
    throw new Error(`emulator -list-avds failed (exit ${code}): ${(stderr || stdout).trim()}`);
  }
  return parseAvdList(stdout);
}

async function findRunningAvd(sdkDir, avdName) {
  const devices = await adbLib.listDevices(adbPath(sdkDir));
  for (const device of devices) {
    if (device.state !== "device" || !device.serial.startsWith("emulator-")) continue;
    const name = await adbLib.emuAvdName(adbPath(sdkDir), device.serial);
    if (name === avdName) return device.serial;
  }
  return null;
}

/**
 * @returns {Promise<{avd: string, serial: string, reused: boolean}>}
 */
async function startEmulator({ sdkDir, projectRoot, requestedAvd, log }) {
  const avds = await listAvds(sdkDir);
  if (avds.length === 0) {
    throw new Error(
      `no AVDs defined for this SDK (${sdkDir}); create one first (e.g. sdkmanager --list | avdmanager create avd ...)`,
    );
  }

  let avd = requestedAvd ?? null;
  if (avd && !avds.includes(avd)) {
    throw new Error(`AVD ${JSON.stringify(avd)} is not defined; known AVDs: ${avds.join(", ")}`);
  }
  if (!avd) {
    if (avds.length === 1) {
      avd = avds[0];
      log(`using the only AVD: ${avd}`);
    } else {
      const index = await menu({
        prompt: "Select an AVD to start:",
        items: avds.map((name) => ({ label: name })),
      });
      if (index === null) throw new Cancelled("no AVD selected; nothing was started");
      avd = avds[index];
    }
  }

  const adbExe = adbPath(sdkDir);
  const emulatorExe = emulatorPath(sdkDir);
  let serial = await findRunningAvd(sdkDir, avd);
  let reused = true;
  if (serial) {
    log(`AVD ${avd} is already running as ${serial}; reusing it`);
  } else {
    const logsDir = path.join(stateDir(), "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(
      logsDir,
      `emulator-${avd}-${new Date().toISOString().replace(/[:.]/g, "")}.log`,
    );
    const logFd = fs.openSync(logPath, "a");
    let exited = null;
    const child = adbLib.spawnDetached(emulatorExe, ["-avd", avd], logFd); // GUI window: no -no-window flags
    child.on("exit", (code, signal) => (exited = { code, signal }));
    log(`starting AVD ${avd} (log: ${logPath})`);

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      if (exited) {
        const why = exited.signal ? `signal ${exited.signal}` : `exit code ${exited.code}`;
        throw new Error(`emulator for AVD ${avd} exited early (${why}); start log: ${logPath}`);
      }
      const current = await findRunningAvd(sdkDir, avd);
      if (current) {
        const boot = await adbLib.getprop(adbExe, current, "sys.boot_completed");
        if (boot === "1") {
          serial = current;
          reused = false;
          break;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `AVD ${avd} did not finish booting within ${BOOT_TIMEOUT_MS / 1000}s${
            current ? ` (still ${current})` : ""
          }; start log: ${logPath}`,
        );
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  writeJson(deviceFile(projectRoot), { avd, serial });
  log(`emulator ready: ${avd} @ ${serial}`);
  return { avd, serial, reused };
}

module.exports = { startEmulator, listAvds, parseAvdList, findRunningAvd, BOOT_TIMEOUT_MS, exe };
