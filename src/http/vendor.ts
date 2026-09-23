import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Browser libraries served under `/vendor/<name>`, straight from their npm packages
 * (runtime dependencies, so the published package brings them along). Only these
 * files are served.
 */
export const VENDOR_FILES: Record<string, { pkg: string; file: string }> = {
  "htmx.min.js": { pkg: "htmx.org", file: "dist/htmx.min.js" },
  "sse.js": { pkg: "htmx-ext-sse", file: "sse.js" },
  "idiomorph-ext.min.js": { pkg: "idiomorph", file: "dist/idiomorph-ext.min.js" },
};

const dirs = new Map<string, string>();

/**
 * Directory of an installed package: the nearest `node_modules/<pkg>` above this
 * module. Found by walking up rather than `require.resolve`, because a package's
 * `exports` map may hide its dist files, and npm may hoist it next to longe.
 */
export async function packageDir(pkg: string, from = import.meta.dirname): Promise<string> {
  const known = dirs.get(pkg);
  if (known) return known;
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", pkg);
    const found = await access(path.join(candidate, "package.json")).then(
      () => true,
      () => false,
    );
    if (found) {
      dirs.set(pkg, candidate);
      return candidate;
    }
    if (path.dirname(dir) === dir) throw new Error(`package ${pkg} is not installed`);
  }
}

/** Absolute path of a served vendor file, or undefined for a name not on the list. */
export async function vendorPath(name: string): Promise<string | undefined> {
  const entry = VENDOR_FILES[name];
  if (!entry) return undefined;
  return path.join(await packageDir(entry.pkg), entry.file);
}
