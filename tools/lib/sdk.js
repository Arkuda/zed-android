"use strict";

// Android SDK / tool discovery. The user's environment is inherited as-is:
// we never substitute the SDK location for the AVD location, and
// ANDROID_SDK_HOME is deliberately ignored (it is not an SDK path).

const fs = require("node:fs");
const path = require("node:path");

function exe(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/**
 * Java .properties unescaping sufficient for `sdk.dir=...` (covers \\, \:, \=,
 * \uXXXX and the plan's `sdk.dir=E\:\\android_sdk` example).
 */
function parseJavaProperties(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    let line = lines[i++];
    // logical line continuation
    while (/\\$/.test(line) && i < lines.length) line = `${line.slice(0, -1)}${lines[i++]}`;
    line = line.trim();
    if (!line || /^[#!]/.test(line)) continue;
    const m = /^((?:\\.|[^=:\s])*)\s*(?:[=:]\s*|\s+)(.*)$/.exec(line);
    let key, value;
    if (m) {
      key = unescape(m[1]);
      value = unescape(m[2].trim());
    } else {
      key = unescape(line);
      value = "";
    }
    out[key] = value;
  }
  function unescape(s) {
    let result = "";
    for (let j = 0; j < s.length; j++) {
      const ch = s[j];
      if (ch !== "\\") {
        result += ch;
        continue;
      }
      const next = s[++j];
      switch (next) {
        case "n": result += "\n"; break;
        case "t": result += "\t"; break;
        case "r": result += "\r"; break;
        case "f": result += "\f"; break;
        case "u": {
          const hex = s.slice(j + 1, j + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result += String.fromCharCode(parseInt(hex, 16));
            j += 4;
          } else {
            result += "u";
          }
          break;
        }
        case undefined: break;
        default: result += next;
      }
    }
    return result;
  }
  return out;
}

function isSdkDir(candidate) {
  return (
    !!candidate &&
    fs.existsSync(path.join(candidate, "platform-tools", exe("adb")))
  );
}

/**
 * Locates the SDK: local.properties sdk.dir -> ANDROID_HOME ->
 * ANDROID_SDK_ROOT -> realpath of a `platform-tools/adb` found on PATH.
 * @returns {{sdkDir: string|null, source: string, tried: string[]}}
 */
function findSdk(projectRoot) {
  const tried = [];
  const localProps = path.join(projectRoot, "local.properties");
  try {
    const props = parseJavaProperties(fs.readFileSync(localProps, "utf8"));
    if (props["sdk.dir"]) {
      tried.push(`local.properties sdk.dir=${props["sdk.dir"]}`);
      if (isSdkDir(props["sdk.dir"])) return { sdkDir: props["sdk.dir"], source: "local.properties", tried };
    } else {
      tried.push("local.properties without sdk.dir");
    }
  } catch (err) {
    if (err.code !== "ENOENT") tried.push(`local.properties unreadable: ${err.message}`);
  }
  for (const name of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const value = process.env[name];
    if (value) {
      tried.push(`${name}=${value}`);
      if (isSdkDir(value)) return { sdkDir: value, source: name, tried };
    }
  }
  // Fall back to the real platform-tools directory behind an `adb` on PATH.
  const pathExts = process.platform === "win32" ? ["", ".exe"] : [""];
  for (const dirEntry of (process.env.PATH || "").split(path.delimiter)) {
    if (!dirEntry) continue;
    for (const ext of pathExts) {
      const candidate = path.join(dirEntry, `adb${ext}`);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile()) continue;
        const real = fs.realpathSync(candidate);
        const parent = path.dirname(real);
        if (path.basename(parent) !== "platform-tools") continue;
        const sdk = path.dirname(parent);
        tried.push(`PATH adb at ${real}`);
        if (isSdkDir(sdk)) return { sdkDir: sdk, source: "PATH platform-tools/adb", tried };
      } catch {
        /* keep looking */
      }
    }
  }
  return { sdkDir: null, source: null, tried };
}

function adbPath(sdkDir) {
  return path.join(sdkDir, "platform-tools", exe("adb"));
}

/** emulator/emulator is only required by the emulator command. */
function emulatorPath(sdkDir) {
  return path.join(sdkDir, "emulator", exe("emulator"));
}

module.exports = { findSdk, adbPath, emulatorPath, parseJavaProperties, isSdkDir, exe };
