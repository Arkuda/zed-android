"use strict";

// State and config locations. Nothing here ever resolves inside an Android
// project except the explicit --config-dir guard in setup.js.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** External state root: %LOCALAPPDATA% / ~/Library/Application Support / ${XDG_STATE_HOME:-~/.local/state}. */
function stateDir() {
  if (process.env.ZED_ANDROID_STATE_DIR) {
    return path.resolve(process.env.ZED_ANDROID_STATE_DIR);
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "zed-android");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "zed-android");
  }
  const xdg = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "zed-android");
}

/** Zed's config directory (crates/paths/src/paths.rs::config_dir defaults). */
function zedConfigDir() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "Zed");
  }
  if (process.platform === "linux") {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(xdg, "zed");
  }
  return path.join(os.homedir(), ".config", "zed");
}

/** Deterministic identity for a Gradle root; survives case/separator spelling differences. */
function canonicalRoot(root) {
  let resolved = path.resolve(root);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    /* keep the resolved spelling when realpath fails (e.g. not yet existing) */
  }
  if (process.platform === "win32") {
    resolved = resolved.replace(/\//g, "\\");
  } else {
    while (resolved.length > 1 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);
  }
  return resolved;
}

function projectHash(root) {
  return crypto.createHash("sha256").update(canonicalRoot(root)).digest("hex");
}

function projectStateDir(root) {
  return path.join(stateDir(), "projects", projectHash(root));
}

function targetFile(root) {
  return path.join(projectStateDir(root), "target.json");
}

function deviceFile(root) {
  return path.join(projectStateDir(root), "device.json");
}

/** Writes via a sibling temp file so readers never observe partial JSON. */
function atomicWrite(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function writeJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Returns {value} or {error}; a corrupt file must never be treated as valid state. */
function readJsonFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { value: null };
    return { error: `cannot read ${filePath}: ${err.message}` };
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { error: `${filePath} does not contain a JSON object` };
    }
    return { value };
  } catch (err) {
    return { error: `${filePath} is not valid JSON: ${err.message}` };
  }
}

module.exports = {
  stateDir,
  zedConfigDir,
  canonicalRoot,
  projectHash,
  projectStateDir,
  targetFile,
  deviceFile,
  atomicWrite,
  writeJson,
  readJsonFile,
};
