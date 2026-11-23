"use strict";

// Shared deploy path used by both `run` and the DAP launch: one Gradle process
// installs (AGP picks the right APK for the device itself) and then describes
// the exact variant for source mapping.

const { deployTarget } = require("./gradle.js");

async function deploy({ root, target, serial, log }) {
  log(`deploying ${target.module} / ${target.variant} / ${target.applicationId} -> ${serial}`);
  const info = await deployTarget(root, target, serial);
  if (info.module !== target.module || info.variant !== target.variant) {
    throw new Error(
      `Gradle described ${info.module}/${info.variant}, expected ${target.module}/${target.variant}`,
    );
  }
  if (info.applicationId !== target.applicationId) {
    throw new Error(
      `installed applicationId is ${info.applicationId}, expected ${target.applicationId}`,
    );
  }
  return info;
}

module.exports = { deploy };
