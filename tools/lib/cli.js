"use strict";

// zed-android command dispatch. Project commands take the Gradle root from the
// current directory (Zed tasks set cwd to $ZED_WORKTREE_ROOT).

const { Cancelled, runPick } = require("./picker.js");
const { setup } = require("./setup.js");
const { findSdk } = require("./sdk.js");
const gradle = require("./gradle.js");
const { resolveTarget } = require("./target.js");
const { startEmulator } = require("./emulator.js");
const { resolveSerial } = require("./device.js");
const launcherMod = require("./launcher.js");
const { deploy } = require("./deploy.js");

const EXIT_OK = 0;
const EXIT_ERR = 1;
const EXIT_USAGE = 2;
const EXIT_CANCEL = 3;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function usage() {
  log(`zed-android — Android integration backend for Zed

commands:
  setup [--config-dir <absolute-dir>]  add global Zed tasks/debug entries to a user profile
  select                               pick application module and variant (menus)
  emulator                             start the selected AVD (reuses a running one)
  build                                assemble the selected variant (no device needed)
  run                                  install + describe via Gradle, resolve launcher, am start
  dap                                  run the DAP server on stdio (started by Zed's debugger)
  pick <request-file>                  answer a runInTerminal selection request

exit codes: 0 ok, 1 error, 2 usage, 3 cancelled by user`);
}

function parseSetupFlags(rest) {
  let configDir;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--config-dir") {
      if (i + 1 >= rest.length) throw new Error("--config-dir needs a value");
      configDir = rest[++i];
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  return { configDir };
}

function requireSdk(root) {
  const found = findSdk(root);
  if (!found.sdkDir) {
    throw new Error(
      `no Android SDK found for ${root}. Checked: ${found.tried.join("; ") || "nothing usable"}; ` +
        "set sdk.dir in local.properties or ANDROID_HOME",
    );
  }
  return found;
}

async function cmdSelect(root) {
  gradle.assertGradleRoot(root);
  const target = await resolveTarget({ root, mode: "run", explicit: true, log });
  log(`selected ${target.module} / ${target.variant} / ${target.applicationId}`);
  return EXIT_OK;
}

async function cmdEmulator(root, requestedAvd) {
  const sdk = requireSdk(root);
  await startEmulator({ sdkDir: sdk.sdkDir, projectRoot: root, requestedAvd, log });
  return EXIT_OK;
}

async function cmdBuild(root) {
  gradle.assertGradleRoot(root);
  const target = await resolveTarget({ root, mode: "build", log });
  log(`target: ${target.module} / ${target.variant} / ${target.applicationId}`);
  const task = await gradle.buildTarget(root, target);
  log(`built ${task}; no device required for this step`);
  return EXIT_OK;
}

async function cmdRun(root) {
  gradle.assertGradleRoot(root);
  const target = await resolveTarget({ root, mode: "run", log });
  const sdk = requireSdk(root);
  const { serial } = await resolveSerial({ sdkDir: sdk.sdkDir, projectRoot: root, log });
  log(`target: ${target.module} / ${target.variant} / ${target.applicationId} -> ${serial}`);
  const adbExe = require("./sdk.js").adbPath(sdk.sdkDir);
  await deploy({ root, target, serial, log });
  const launcher = await launcherMod.resolveComponent({
    root, adbExe, serial, applicationId: target.applicationId, log,
  });
  await launcherMod.startActivity({
    adbExe, serial,
    applicationId: target.applicationId,
    component: launcher.component,
    category: launcher.category,
    log,
  });
  return EXIT_OK;
}

async function main(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        usage();
        return EXIT_OK;
      case "setup": {
        const { configDir } = parseSetupFlags(rest);
        return await setup({ configDir, log });
      }
      case "select":
        return await cmdSelect(process.cwd());
      case "emulator":
        if (rest.length > 1) throw new Error("usage: zed-android emulator [avd-name]");
        return await cmdEmulator(process.cwd(), rest[0]);
      case "build":
        return await cmdBuild(process.cwd());
      case "run":
        return await cmdRun(process.cwd());
      case "pick":
        if (rest.length !== 1) throw new Error("usage: zed-android pick <request-file>");
        return await runPick(rest[0]);
      case "dap": {
        const { runDap } = require("./dap.js");
        return await runDap();
      }
      default:
        process.stderr.write(`zed-android: unknown command ${JSON.stringify(command ?? "")}\n`);
        usage();
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof Cancelled || (err && err.cancelled)) {
      log(`zed-android: ${err.message}`);
      return EXIT_CANCEL;
    }
    process.stderr.write(`zed-android: ${err?.message ?? err}\n`);
    if (process.env.ZED_ANDROID_DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
    return EXIT_ERR;
  }
}

module.exports = { main, EXIT_OK, EXIT_ERR, EXIT_USAGE, EXIT_CANCEL };
