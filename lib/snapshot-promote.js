/**
 * Copying a validated staging directory into data/.
 *
 * Extracted from refresh-snapshots.mjs so the file list can be tested without running the
 * whole pipeline — because the file list was the bug.
 *
 * The first version iterated `step.outputs` alone and ignored `optionalOutputs`. That second
 * list records what a generator may legitimately not produce (`build-data.mjs` writes no
 * base.json under --skip-base), not what should be withheld from publication. So every CI run
 * generated a fresh base.json, verified it against the published copy, and then deleted it
 * along with the staging directory: data/base.json stayed frozen at whatever a local run last
 * wrote, and the Base section of the page quietly stopped being current.
 *
 * Nothing failed. The job was green, the commit was clean, and the only symptom was a
 * freshness banner the reader had to interpret — the same shape of bug as HANDOFF #15 and
 * #17: a step that degrades in silence instead of saying so.
 */
import { copyFileSync, renameSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_FS = {
  exists: existsSync,
  read: readFileSync,
  copy: copyFileSync,
  rename: renameSync,
  remove: (p) => rmSync(p, { force: true }),
};

/**
 * @param {object} opts
 * @param {{outputs?:string[], optionalOutputs?:string[]}[]} opts.steps
 * @param {string} opts.staging  directory the generators wrote into
 * @param {string} opts.dataDir  directory the site is served from
 * @param {object} [opts.fs]     injectable, so the list logic is testable without a disk
 * @returns {{updated:string[], unchanged:string[], missing:string[]}}
 */
export function promoteSnapshots({ steps, staging, dataDir, fs = DEFAULT_FS }) {
  const updated = [];
  const unchanged = [];
  const missing = [];

  for (const step of steps) {
    for (const file of [...(step.outputs || []), ...(step.optionalOutputs || [])]) {
      const from = join(staging, file);
      if (!fs.exists(from)) {
        missing.push(file);
        continue;
      }
      const to = join(dataDir, file);
      const tmp = to + ".incoming";
      // Write next to the target, then rename: a reader never sees a half-written file.
      fs.copy(from, tmp);
      // Byte comparison is the "no empty commit" guard: the workflow only commits when
      // something actually changed, and this is where that is decided.
      if (fs.exists(to) && Buffer.compare(fs.read(to), fs.read(tmp)) === 0) {
        fs.remove(tmp);
        unchanged.push(file);
        continue;
      }
      fs.rename(tmp, to);
      updated.push(file);
    }
  }

  return { updated, unchanged, missing };
}
