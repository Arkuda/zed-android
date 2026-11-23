"use strict";

// Gradle orchestration: the project's own wrapper plus our external init
// script. No shell-string interpolation of paths or settings anywhere.

const fs = require("node:fs");
const path = require("node:path");

const crossSpawn = require("cross-spawn");

const INIT_SCRIPT = path.join(__dirname, "..", "gradle", "android.init.gradle");

const TARGETS_MARKER = "ZED_ANDROID_TARGETS:";
const VARIANT_MARKER = "ZED_ANDROID_VARIANT:";

/** Validate the Gradle root before invoking anything (global tasks also run outside Android projects). */
function assertGradleRoot(root) {
  const settings = [
    path.join(root, "settings.gradle"),
    path.join(root, "settings.gradle.kts"),
  ].find((p) => fs.existsSync(p));
  if (!settings) {
    throw new Error(
      `${root} is not a Gradle project root (no settings.gradle[.kts]); open the Android project folder in Zed`,
    );
  }
  const wrapper =
    process.platform === "win32" ? path.join(root, "gradlew.bat") : path.join(root, "gradlew");
  if (!fs.existsSync(wrapper)) {
    throw new Error(`Gradle Wrapper not found: ${wrapper}`);
  }
  return wrapper;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** ':app'/'debug' -> ':app:assembleDebug'; root module ':' must not double the colon. */
function taskPath(module, verb, variant) {
  const prefix = module === ":" ? ":" : `${module}:`;
  return `${prefix}${verb}${capitalize(variant)}`;
}

/**
 * Run the project's wrapper with our init script attached.
 * Lines carrying our markers are captured; everything else is echoed so the
 * user sees real Gradle progress in the Zed terminal.
 */
function runGradle(root, tasks, { discovery = false, props = {}, env = {} } = {}) {
  const wrapper = assertGradleRoot(root);
  if (!fs.existsSync(INIT_SCRIPT)) {
    throw new Error(`init script missing from the extension install: ${INIT_SCRIPT}`);
  }
  const args = ["--init-script", INIT_SCRIPT, "--console=plain"];
  if (discovery) args.push("--no-configure-on-demand", "--no-configuration-cache");
  for (const [key, value] of Object.entries(props)) args.push(`-P${key}=${value}`);
  args.push(...tasks);

  return new Promise((resolve, reject) => {
    const child = crossSpawn(wrapper, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const markers = [];
    let lineBuf = "";
    const handleChunk = (chunk, stream) => {
      lineBuf += chunk;
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop();
      for (const line of lines) {
        if (line.startsWith(TARGETS_MARKER) || line.startsWith(VARIANT_MARKER)) {
          markers.push(line);
        } else {
          stream.write(`${line}\n`);
        }
      }
    };
    child.stdout.on("data", (d) => handleChunk(d, process.stdout));
    child.stderr.pipe(process.stderr, { end: false });
    child.on("error", (err) => reject(new Error(`failed to start ${wrapper}: ${err.message}`)));
    child.on("close", (code) => {
      if (lineBuf) {
        if (lineBuf.startsWith(TARGETS_MARKER) || lineBuf.startsWith(VARIANT_MARKER)) {
          markers.push(lineBuf);
        } else {
          process.stdout.write(`${lineBuf}\n`);
        }
      }
      resolve({ code, markers });
    });
  });
}

function parseMarkerJson(markers, marker, what) {
  const hits = markers.filter((m) => m.startsWith(marker));
  if (hits.length === 0) {
    throw new Error(`Gradle produced no ${what} payload (${marker.trim()} marker missing)`);
  }
  if (hits.length > 1) {
    throw new Error(`Gradle produced ${hits.length} ${what} payloads; expected exactly one`);
  }
  const raw = hits[0].slice(marker.length);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${what} payload is not valid JSON: ${err.message}`);
  }
}

/** Fresh trusted model: [{module, variant, applicationId, debuggable}] */
async function discoverTargets(root) {
  const { code, markers } = await runGradle(root, [":zedAndroidTargets"], { discovery: true });
  if (code !== 0) throw new Error(`target discovery failed: Gradle exit ${code}`);
  const targets = parseMarkerJson(markers, TARGETS_MARKER, "target model");
  if (!Array.isArray(targets)) throw new Error("target model is not a JSON array");
  return targets;
}

/** Build only; no device required. */
async function buildTarget(root, target) {
  const task = taskPath(target.module, "assemble", target.variant);
  const { code } = await runGradle(root, [task], {
    props: guardProps(target),
  });
  if (code !== 0) throw new Error(`build failed: Gradle exit ${code}`);
  return task;
}

/** One Gradle process installs and then describes the exact variant. */
async function deployTarget(root, target, serial) {
  const install = taskPath(target.module, "install", target.variant);
  const describe = taskPath(target.module, "zedAndroidDescribe", target.variant);
  const { code, markers } = await runGradle(root, [install, describe], {
    props: guardProps(target),
    env: { ANDROID_SERIAL: serial },
  });
  if (code !== 0) throw new Error(`install failed: Gradle exit ${code}`);
  const info = parseMarkerJson(markers, VARIANT_MARKER, "variant description");
  for (const key of ["module", "variant", "applicationId", "projectDir"]) {
    if (typeof info[key] !== "string") throw new Error(`variant description lacks "${key}"`);
  }
  return info;
}

function guardProps(target) {
  const props = { zedAndroidModule: target.module, zedAndroidVariant: target.variant };
  if (target.applicationId) props.zedAndroidApplicationId = target.applicationId;
  return props;
}

module.exports = {
  assertGradleRoot,
  taskPath,
  runGradle,
  discoverTargets,
  buildTarget,
  deployTarget,
  INIT_SCRIPT,
  TARGETS_MARKER,
  VARIANT_MARKER,
};
