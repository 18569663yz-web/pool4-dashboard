/**
 * Where a snapshot generator writes its output.
 *
 * Default is `data/`, which is what a human running `node scripts/…` expects. The
 * refresh workflow passes `--out-dir <tmp>` so every artifact can be validated *before*
 * it replaces the file the site serves — an unattended job on a data source that
 * occasionally returns nonsense (NOTES.md §16) must never write straight to the live path.
 *
 * Inputs are deliberately NOT redirected: an incremental indexer still reads the previous
 * `data/history.json` as its starting point, it just writes the new one elsewhere.
 */
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The directory snapshots are written into. */
export function outDir() {
  const i = process.argv.indexOf("--out-dir");
  const raw = i >= 0 ? process.argv[i + 1] : null;
  if (!raw) return join(ROOT, "data");
  const dir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path for one snapshot file. */
export function outPath(name) {
  const dir = outDir();
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  return join(dir, name);
}
