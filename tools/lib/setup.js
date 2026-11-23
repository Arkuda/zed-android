"use strict";

// `zed-android setup`: one-time user-profile configuration. Writes only Zed's
// global tasks.json/debug.json; never touches the Android project.

const fs = require("node:fs");
const path = require("node:path");

const { mergeEntries } = require("./jsonc.js");
const { zedConfigDir, atomicWrite } = require("./paths.js");

const TASK_ENTRIES = [
  {
    label: "Android: Select application",
    command: "zed-android",
    args: ["select"],
    cwd: "$ZED_WORKTREE_ROOT",
  },
  {
    label: "Android: Start emulator",
    command: "zed-android",
    args: ["emulator"],
    cwd: "$ZED_WORKTREE_ROOT",
  },
  {
    label: "Android: Build",
    command: "zed-android",
    args: ["build"],
    cwd: "$ZED_WORKTREE_ROOT",
    save: "all",
  },
  {
    label: "Android: Run",
    command: "zed-android",
    args: ["run"],
    cwd: "$ZED_WORKTREE_ROOT",
    save: "all",
  },
];

const DEBUG_ENTRIES = [{ label: "Android: Debug", adapter: "Android", request: "launch" }];

/** A config directory nested in a Gradle project would silently turn global
 *  tasks into project-scoped ones; refuse it. */
function assertOutsideGradleProject(dir) {
  let current = path.resolve(dir);
  for (;;) {
    const hasSettings =
      fs.existsSync(path.join(current, "settings.gradle")) ||
      fs.existsSync(path.join(current, "settings.gradle.kts"));
    const hasWrapper =
      fs.existsSync(path.join(current, "gradlew")) ||
      fs.existsSync(path.join(current, "gradlew.bat"));
    if (hasSettings && hasWrapper) {
      return `the config directory ${dir} resolves inside the Gradle project ${current}`;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * @param {{configDir?: string, log: (msg:string)=>void}} options
 * @returns {Promise<number>} exit code
 */
async function setup({ configDir, log }) {
  let dir;
  if (configDir !== undefined) {
    if (!path.isAbsolute(configDir)) {
      log(`setup: --config-dir must be an absolute directory, got "${configDir}"`);
      return 1;
    }
    dir = configDir;
  } else {
    dir = zedConfigDir();
  }
  const nested = assertOutsideGradleProject(dir);
  if (nested) {
    log(`setup: refusing to write global Zed files: ${nested}`);
    return 1;
  }

  const files = [
    { file: path.join(dir, "tasks.json"), entries: TASK_ENTRIES },
    { file: path.join(dir, "debug.json"), entries: DEBUG_ENTRIES },
  ];

  // Validate both files completely before touching either one.
  const plans = [];
  for (const { file, entries } of files) {
    let text;
    let created = false;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        text = "[]\n";
        created = true;
      } else {
        log(`setup: cannot read ${file}: ${err.message}`);
        return 1;
      }
    }
    const result = mergeEntries(text, entries);
    if (!result.ok) {
      log(`setup: conflict in ${file}: ${result.reason}; nothing was changed`);
      return 1;
    }
    plans.push({ file, created, ...result });
  }

  let changedAny = false;
  for (const plan of plans) {
    if (!plan.changed && !plan.created) {
      log(`setup: ${plan.file} already contains the Android entries (unchanged)`);
      continue;
    }
    atomicWrite(plan.file, plan.text);
    changedAny = true;
    log(
      `setup: ${plan.file}: ${plan.created ? "created" : "updated"} ` +
        `[${plan.added.map((label) => JSON.stringify(label)).join(", ") || "no additions"}]`,
    );
  }
  if (!changedAny) log("setup: profile is already configured");
  return 0;
}

module.exports = { setup, TASK_ENTRIES, DEBUG_ENTRIES, assertOutsideGradleProject };
