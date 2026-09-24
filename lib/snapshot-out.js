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
import { existsSync, mkdirSync } from "node:fs";
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

/**
 * Where a generator reads an input that an *earlier step of the same run* produced.
 *
 * The counterpart of `outPath`, and it exists because of a bug that failed every scheduled
 * run with an identical block number. The refresh job runs the generators in sequence into
 * one staging directory, and `build-data.mjs` consumes the `history.json` that
 * `index-logs.mjs` wrote moments earlier. It used to read `data/` instead — so every run
 * rebuilt the timeline from the *committed* index, which never advances, because the
 * workflow deliberately never commits that 7 MB file (actions/cache carries it instead).
 * The timeline therefore came out byte-identical every hour and one window shorter than the
 * copy in the repository, and `verify-snapshots.mjs` correctly rejected it as history going
 * backwards. The failure looked like a stale RPC endpoint; it was a path.
 *
 * Outside the refresh job (no `--out-dir`) the staging directory *is* `data/`, so this
 * resolves to the plain path and local runs behave exactly as they did.
 */
export function stagedPath(name) {
  const staged = join(outDir(), name);
  if (existsSync(staged)) return staged;
  const fallback = join(ROOT, "data", name);
  console.warn(`note: ${name} was not produced in this run's staging directory; falling back to ${fallback}`);
  return fallback;
}
