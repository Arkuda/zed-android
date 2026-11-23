"use strict";

// Launcher activity resolution after deploy: Package Manager is the source of
// truth (equivalent to Studio's post-install APK activity lookup). LAUNCHER
// and LEANBACK_LAUNCHER are queried separately and merged by component.

const adbLib = require("./adb.js");
const { menu, Cancelled } = require("./picker.js");
const { targetFile, readJsonFile } = require("./paths.js");
const { updateTargetExtras } = require("./target.js");

const LAUNCHER = "android.intent.category.LAUNCHER";
const LEANBACK = "android.intent.category.LEANBACK_LAUNCHER";

/** Component tokens like `pkg/.MainActivity` or `pkg/pkg.sub.Class$Inner`. */
function extractComponents(stdout) {
  const found = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes("/")) continue;
    if (/^\d+ activities? found|^No activities/i.test(line)) continue;
    // `package/.RelativeName` and `package/full.qualified.Name` both occur;
    // header/Install-path lines never match this shape
    const m = /^([A-Za-z][\w.]*\/[.]?[A-Za-z][\w.$]*)$/.exec(line);
    if (m) found.push(m[1]);
  }
  return found;
}

/**
 * @returns {Promise<Array<{component: string, categories: string[]}>>}
 */
async function queryLaunchers({ adbExe, serial, applicationId }) {
  const merged = new Map();
  for (const category of [LAUNCHER, LEANBACK]) {
    const result = await adbLib.shell(adbExe, serial, [
      "cmd", "package", "query-activities", "--components", "--user", "current",
      "-a", "android.intent.action.MAIN", "-c", category, "-p", applicationId,
    ]);
    const components = extractComponents(result.stdout);
    if (result.code !== 0 && components.length === 0) {
      const detail = (result.stderr || result.stdout).trim();
      // `query-activities` reports "No activities found" with exit 0 on most
      // builds; a non-zero exit without output is a real device-side error.
      if (detail && !/no activities found/i.test(detail)) {
        throw new Error(`package query-activities (${category.split(".").pop()}) failed: ${detail}`);
      }
    }
    for (const component of components) {
      if (!merged.has(component)) merged.set(component, new Set());
      merged.get(component).add(category);
    }
  }
  return [...merged.entries()].map(([component, categories]) => ({
    component,
    categories: [...categories],
  }));
}

function pickCategory(entry) {
  // Both categories on one component: plain LAUNCHER wins.
  return entry.categories.includes(LAUNCHER) ? LAUNCHER : entry.categories[0];
}

/**
 * Resolve which component to start for the freshly installed applicationId.
 * A saved component is revalidated against the fresh list every time.
 */
async function resolveComponent({ root, adbExe, serial, applicationId, log, ask = menu, persist = true }) {
  const entries = await queryLaunchers({ adbExe, serial, applicationId });
  if (entries.length === 0) {
    throw new Error(
      `${applicationId} is installed but exposes no MAIN/LAUNCHER activity; Build remains available for this variant`,
    );
  }

  const saved = readJsonFile(targetFile(root)).value;
  if (saved?.component && typeof saved.component.component === "string") {
    const hit = entries.find((e) => e.component === saved.component.component);
    if (hit) return { ...hit, category: pickCategory(hit), source: "saved" };
    log(`saved launcher ${saved.component.component} is no longer exported by ${applicationId}; resolving again`);
  }

  if (entries.length === 1) {
    return { ...entries[0], category: pickCategory(entries[0]), source: "single" };
  }

  const index = await ask({
    prompt: `${applicationId} exports several launcher activities; select one:`,
    items: entries.map((e) => ({
      label: `${e.component}${e.categories.includes(LEANBACK) ? " (leanback)" : ""}`,
    })),
  });
  if (index === null) throw new Cancelled("no launcher activity selected; nothing was started");
  const chosen = entries[index];
  const entry = { ...chosen, category: pickCategory(chosen), source: "picked" };
  if (persist) {
    updateTargetExtras(root, { component: { component: entry.component, category: entry.category } });
  }
  return entry;
}

/** `am start -W` with the user-visible summary and error surfacing. */
async function startActivity({ adbExe, serial, applicationId, component, category, log }) {
  const result = await adbLib.shell(adbExe, serial, [
    "am", "start", "-W", "--user", "current",
    "-a", "android.intent.action.MAIN",
    "-c", category,
    "-n", component,
  ], { timeoutMs: 120_000 });
  const text = [result.stdout, result.stderr].filter((s) => s && s.trim()).join("\n").trim();
  log(`starting ${applicationId} / ${component} on ${serial} (${category.split(".").pop()})`);
  if (text) process.stdout.write(`${text}\n`);
  const failed =
    result.code !== 0 ||
    /^\s*Error\b/im.test(text) ||
    (/Status:/i.test(text) && !/Status:\s*ok/i.test(text));
  if (failed) {
    throw new Error(`am start failed (exit ${result.code}): ${text.split("\n")[0] || "no output"}`);
  }
  return result;
}

module.exports = { queryLaunchers, extractComponents, resolveComponent, startActivity, pickCategory, LAUNCHER, LEANBACK };
