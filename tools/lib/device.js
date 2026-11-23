"use strict";

// Device selection. Precedence: explicit ANDROID_SERIAL -> validated saved
// device -> the single online target -> an explicit pick from `adb devices -l`.
// offline/unauthorized are never acceptable; cancellation never deploys.

const adbLib = require("./adb.js");
const { menu, Cancelled } = require("./picker.js");
const { adbPath } = require("./sdk.js");
const { deviceFile, readJsonFile, writeJson } = require("./paths.js");

function describeDevices(devices) {
  return devices.map((d) => `${d.serial} [${d.state}]${d.model ? ` model=${d.model}` : ""}`).join(", ");
}

/**
 * @returns {Promise<{serial: string, source: string}>}
 */
async function resolveSerial({ sdkDir, projectRoot, log, ask = menu }) {
  const adbExe = adbPath(sdkDir);
  if (!require("node:fs").existsSync(adbExe)) {
    throw new Error(`adb not found: ${adbExe}`);
  }
  const devices = await adbLib.listDevices(adbExe);
  const online = devices.filter((d) => d.state === "device");

  const envSerial = (process.env.ANDROID_SERIAL ?? "").trim();
  if (envSerial) {
    const matches = devices.filter((d) => d.serial === envSerial);
    if (matches.length !== 1 || matches[0].state !== "device") {
      throw new Error(
        `ANDROID_SERIAL=${JSON.stringify(envSerial)} must name exactly one device in state "device"; ` +
          `connected: ${devices.length ? describeDevices(devices) : "none"}`,
      );
    }
    return { serial: envSerial, source: "ANDROID_SERIAL" };
  }

  const saved = readJsonFile(deviceFile(projectRoot)).value;
  if (saved && typeof saved.serial === "string" && saved.serial) {
    const entry = online.find((d) => d.serial === saved.serial);
    if (entry) {
      if (saved.avd && entry.serial.startsWith("emulator-")) {
        const name = await adbLib.emuAvdName(adbExe, entry.serial);
        if (name !== saved.avd) {
          throw new Error(
            `saved device ${entry.serial} now reports AVD ${JSON.stringify(name ?? "unknown")}, ` +
              `expected ${JSON.stringify(saved.avd)}; run Android: Start emulator to pick a new target`,
          );
        }
      }
      return { serial: entry.serial, source: "saved" };
    }
    log(`saved device ${saved.serial} is not connected anymore; selecting again`);
  }

  if (online.length === 0) {
    const states = devices.length ? describeDevices(devices) : "no devices at all";
    throw new Error(
      `no device in state "device" (${states}); run the Android: Start emulator task first`,
    );
  }
  if (online.length === 1) {
    const serial = online[0].serial;
    writeJson(deviceFile(projectRoot), { avd: null, serial });
    return { serial, source: "single-online" };
  }

  const index = await ask({
    prompt: "Select the target device:",
    items: online.map((d) => ({ label: `${d.model ?? d.serial} (${d.serial})` })),
  });
  if (index === null) throw new Cancelled("no device selected; nothing was installed");
  const serial = online[index].serial;
  writeJson(deviceFile(projectRoot), { avd: null, serial });
  return { serial, source: "picked" };
}

module.exports = { resolveSerial, describeDevices };
