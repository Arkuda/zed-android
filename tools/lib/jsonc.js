"use strict";

// Merge of required entries into Zed's global JSONC files. Foreign entries,
// comments and formatting are preserved: edits go through jsonc-parser's
// modify/applyEdits instead of re-serializing the document.

const jsonc = require("jsonc-parser");

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => bk.includes(k) && deepEqual(a[k], b[k]));
}

/**
 * Locates the task/scenario list inside a parsed JSONC document.
 * @returns {{path: (string|number)[], list: unknown[]|null} | {error: string}}
 */
function locateList(root) {
  if (Array.isArray(root)) return { path: [], list: root };
  if (root !== null && typeof root === "object") {
    if (!("tasks" in root)) return { path: ["tasks"], list: [] };
    if (!Array.isArray(root.tasks)) return { error: "the \"tasks\" key must hold an array" };
    return { path: ["tasks"], list: root.tasks };
  }
  return { error: "the file root must be a JSON object or array" };
}

/**
 * Merges entries (matched by `label`) into `text`.
 * Never mutates on conflict/invalid input; the caller decides what to write.
 * @returns {{ok:true, text:string, changed:boolean, added:string[], updated:string[]} | {ok:false, reason:string}}
 */
function mergeEntries(text, entries) {
  const parseErrors = [];
  const root = jsonc.parse(text, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length > 0) {
    const e = parseErrors[0];
    return { ok: false, reason: `not valid JSONC (offset ${e.offset}, error code ${e.error})` };
  }
  const located = locateList(root);
  if (located.error) return { ok: false, reason: located.error };

  const added = [];
  const updated = [];
  let out = text;
  let changed = false;

  for (const entry of entries) {
    const existingIndex = located.list.findIndex(
      (item) => item !== null && typeof item === "object" && !Array.isArray(item) && item.label === entry.label,
    );
    if (existingIndex >= 0) {
      if (!deepEqual(located.list[existingIndex], entry)) {
        return {
          ok: false,
          reason:
            `label ${JSON.stringify(entry.label)} already exists with different contents: ` +
            JSON.stringify(located.list[existingIndex]),
        };
      }
      updated.push(entry.label);
      continue; // identical entry: keep the file bytes untouched for it
    }
    const insertPath = [...located.path, located.list.length + added.length];
    const edits = jsonc.modify(out, insertPath, entry, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    out = jsonc.applyEdits(out, edits);
    added.push(entry.label);
    changed = true;
  }

  if (changed && !out.endsWith("\n")) out += "\n";
  return { ok: true, text: out, changed, added, updated };
}

module.exports = { mergeEntries, deepEqual };
