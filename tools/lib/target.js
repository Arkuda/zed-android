"use strict";

// Module -> variant -> device are independent decisions resolved from a fresh
// Gradle model on every command; the saved pair is only trusted after an exact
// match against that model (including applicationId).

const { discoverTargets } = require("./gradle.js");
const { menu, Cancelled } = require("./picker.js");
const { targetFile, readJsonFile, writeJson } = require("./paths.js");

/** module -> [{variant, applicationId, debuggable}] */
function groupApps(targets) {
  const byModule = new Map();
  for (const t of targets) {
    if (!byModule.has(t.module)) byModule.set(t.module, []);
    byModule.get(t.module).push({
      variant: t.variant,
      applicationId: t.applicationId,
      debuggable: !!t.debuggable,
    });
  }
  for (const list of byModule.values()) {
    list.sort((a, b) => (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0));
  }
  return byModule;
}

function samePair(a, b) {
  return a.module === b.module && a.variant === b.variant && a.applicationId === b.applicationId;
}

/**
 * Resolve the (module, variant, applicationId) snapshot for one command.
 * @param {"build"|"run"|"debug"} mode
 * @param {boolean} explicit - from `zed-android select`: always open menus
 * @param {boolean} persist - write target.json (false for DAP snapshots)
 */
async function resolveTarget({ root, mode, explicit = false, persist = true, log, ask = menu }) {
  const targets = await discoverTargets(root);
  const apps = groupApps(targets);
  if (apps.size === 0) {
    throw new Error(
      `${root} has no com.android.application modules; libraries and dynamic-features alone cannot be run`,
    );
  }

  let saved = null;
  const read = readJsonFile(targetFile(root));
  if (read.error) log(`warning: ${read.error}; selecting again`);
  else saved = read.value;

  if (!explicit && saved) {
    const variants = apps.get(saved.module);
    const hit = variants?.find(
      (v) => samePair({ module: saved.module, ...v }, saved) && (mode !== "debug" || v.debuggable),
    );
    if (hit) {
      return { module: saved.module, variant: hit.variant, applicationId: hit.applicationId, debuggable: hit.debuggable };
    }
    const why = !variants
      ? `module ${saved.module} is gone`
      : mode === "debug" && variants.some((v) => samePair({ module: saved.module, ...v }, saved))
        ? `${saved.module}/${saved.variant} is not debuggable`
        : `variant ${saved.module}/${saved.variant} (${saved.applicationId}) no longer matches`;
    log(`saved target invalid: ${why}; selecting again`);
  }

  // --- module choice ---
  let moduleName;
  if (apps.size === 1 && !explicit) {
    moduleName = [...apps.keys()][0];
  } else {
    const modules = [...apps.keys()].sort();
    const index = await ask({
      prompt: "Select the Android application module:",
      items: modules.map((m) => ({ label: m, current: saved?.module === m })),
    });
    if (index === null) throw new Cancelled("no module selected; nothing was built or installed");
    moduleName = modules[index];
  }

  // --- variant choice ---
  let variants = apps.get(moduleName);
  if (mode === "debug") {
    const debuggable = variants.filter((v) => v.debuggable);
    if (debuggable.length === 0) {
      throw new Error(
        `${moduleName} has no debuggable variant (${variants.map((v) => v.variant).join(", ")}); ` +
          "Debug needs a build type with debuggable enabled",
      );
    }
    variants = debuggable;
  }
  let chosen;
  if (variants.length === 1 && !explicit) {
    chosen = variants[0];
  } else {
    const index = await ask({
      prompt: `Select the variant of ${moduleName}:`,
      items: variants.map((v) => ({
        label:
          `${v.variant} (${v.applicationId}${v.debuggable ? ", debuggable" : ""})` +
          (v.variant === "debug" ? "  [suggested]" : ""),
        current: saved?.module === moduleName && saved?.variant === v.variant,
      })),
    });
    if (index === null) throw new Cancelled("no variant selected; nothing was built or installed");
    chosen = variants[index];
  }

  const target = {
    module: moduleName,
    variant: chosen.variant,
    applicationId: chosen.applicationId,
    debuggable: chosen.debuggable,
  };
  if (persist) saveTarget(root, saved, target, log);
  return target;
}

/**
 * Persist the pair atomically. Launcher component / processName belong to a
 * specific pair: keep them only while the pair is unchanged.
 */
function saveTarget(root, saved, target, log) {
  const same = saved && samePair(saved, target);
  const next = { module: target.module, variant: target.variant, applicationId: target.applicationId };
  if (same) {
    if (typeof saved.processName === "string" && saved.processName) next.processName = saved.processName;
    if (saved.component && typeof saved.component.component === "string") {
      next.component = saved.component;
    }
  } else if (saved) {
    log(`target changed from ${saved.module}/${saved.variant}; launcher and process settings reset`);
  }
  writeJson(targetFile(root), next);
}

/** Re-read target.json after a launcher pick (component belongs to the pair). */
function updateTargetExtras(root, extras) {
  const read = readJsonFile(targetFile(root));
  const current = read.value ?? {};
  writeJson(targetFile(root), { ...current, ...extras });
}

module.exports = { resolveTarget, groupApps, samePair, saveTarget, updateTargetExtras };
