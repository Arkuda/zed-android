"use strict";

// Two-way map between on-disk source files and JVM type signatures, built from
// the Gradle describe payload (variant source roots + matching library-project
// roots). Replaces upstream's APK/manifest source scan: nothing is cached on
// disk and every lookup re-checks the filesystem.

const fs = require("node:fs");
const path = require("node:path");

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

class FileIndex {
  /** @param {{javaSources?: string[], kotlinSources?: string[], runtimeProjectDeps?: Array<{path: string, variant: string, roots: string[]}>}} info */
  constructor(info) {
    /** absolute source roots, deduplicated, no trailing separator */
    this.roots = [];
    const add = (dir) => {
      if (!dir || typeof dir !== "string") return;
      const d = path.resolve(dir);
      if (!this.roots.includes(d)) this.roots.push(d);
    };
    for (const d of info.javaSources ?? []) add(d);
    for (const d of info.kotlinSources ?? []) add(d);
    for (const dep of info.runtimeProjectDeps ?? []) for (const d of dep.roots ?? []) add(d);
  }

  /**
   * Forward lookup for breakpoint requests: an absolute source path becomes the
   * candidate JVM type names that could carry its code.
   * - `MainActivity.kt` -> [pkg/MainActivity, pkg/MainActivityKt] (file facade)
   * - inner classes and lambdas are covered by the engine's `$suffix` match.
   * @returns {{qtypes: string[], srcfpn: string} | null} or null when the path is
   *          outside every known root or not a .java/.kt file.
   */
  candidates(absPath) {
    if (typeof absPath !== "string" || !/\.(java|kt)$/i.test(absPath)) return null;
    const p = path.resolve(absPath);
    for (const root of this.roots) {
      const rel = relativeUnder(root, p);
      if (rel === null) continue;
      const parts = rel.split(path.sep).filter(Boolean);
      const file = parts.pop();
      if (!file) continue;
      const base = file.replace(/\.(java|kt)$/i, "");
      const pkgpath = parts.join("/"); // JVM internal form (may be "" for default package)
      const qtypes = [];
      const qualified = (name) => (pkgpath ? `${pkgpath}/${name}` : name);
      qtypes.push(qualified(base));
      if (/\.kt$/i.test(file)) {
        const kt = qualified(`${base}Kt`);
        if (!qtypes.includes(kt)) qtypes.push(kt);
      }
      // Engine-relative form: /pkg/path/Base.ext with forward slashes.
      const srcfpn = `/${pkgpath ? `${pkgpath}/` : ""}${base}.java`;
      return { qtypes, srcfpn };
    }
    return null;
  }

  /**
   * Reverse lookup for stack frames: a JVM type signature becomes the source
   * file that was compiled into it (existence-checked every call).
   * - `Lpkg/Foo$Inner;` resolves through `Foo`; `FooKt` falls back to `Foo.kt`.
   * @param {string} signature e.g. `Ldev/phosphor/launcher/MainActivity;`
   * @returns {string | null} absolute path or null (framework classes etc.)
   */
  sourceFor(signature) {
    const m = /^L([^;]+);$/.exec(signature ?? "");
    if (!m) return null;
    const top = m[1].split("$")[0]; // inner/anonymous classes live in the outer file
    const slash = top.lastIndexOf("/");
    const pkgpath = slash >= 0 ? top.slice(0, slash) : "";
    const base = slash >= 0 ? top.slice(slash + 1) : top;
    if (!base || /[^\w$]/.test(base)) return null;
    const dirs = pkgpath ? pkgpath.split("/") : [];
    for (const root of this.roots) {
      const dir = path.join(root, ...dirs);
      const tries = [path.join(dir, `${base}.kt`), path.join(dir, `${base}.java`)];
      if (/Kt$/.test(base)) {
        const outer = base.slice(0, -2);
        tries.push(path.join(dir, `${outer}.kt`), path.join(dir, `${outer}.java`));
      }
      for (const p of tries) {
        try {
          if (fs.statSync(p).isFile()) return p;
        } catch {
          /* keep looking */
        }
      }
    }
    return null;
  }
}

/** rel path under root or null; separator- and platform-aware. */
function relativeUnder(root, p) {
  const prefix = root + path.sep;
  const eq = CASE_INSENSITIVE
    ? p.toLowerCase().startsWith(prefix.toLowerCase())
    : p.startsWith(prefix);
  if (!eq) return null;
  const rel = p.slice(prefix.length);
  if (!rel || rel.includes(":")) return null; // drive jump via relative() edge case
  return rel;
}

module.exports = { FileIndex, relativeUnder };
