// Which files the refresh job actually publishes.
//
// The promote loop iterated `step.outputs` alone and ignored `optionalOutputs`. base.json is
// optional to *produce* — build-data.mjs writes none under --skip-base — but it is not
// optional to publish. So every CI run generated a fresh base.json, verified it against the
// published copy, and then deleted it along with the staging directory. data/base.json stayed
// frozen at whatever a local run last wrote, the Base section of the page went stale, and
// nothing failed: the job was green and the commit was clean.
//
//   node scripts/test-promote.mjs
import { join } from "node:path";
import { promoteSnapshots } from "../lib/snapshot-promote.js";

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? "\n       " + detail : ""}`);
  }
};

/** A filesystem in a Map, so these tests are about the file list and nothing else. */
function fakeFs(initial) {
  const files = new Map(Object.entries(initial));
  const calls = { copy: [], rename: [], remove: [] };
  return {
    files,
    calls,
    exists: (p) => files.has(p),
    read: (p) => Buffer.from(files.get(p)),
    copy: (a, b) => {
      calls.copy.push([a, b]);
      files.set(b, files.get(a));
    },
    rename: (a, b) => {
      calls.rename.push([a, b]);
      files.set(b, files.get(a));
      files.delete(a);
    },
    remove: (p) => {
      calls.remove.push(p);
      files.delete(p);
    },
  };
}

const STEPS = [
  { id: "index", outputs: ["history.json"] },
  { id: "timeline", outputs: ["timeline.json"], optionalOutputs: ["base.json"] },
];

const stage = (f) => join("stage", f);
const data = (f) => join("data", f);

console.log("an optional output is published like any other");
{
  const fs = fakeFs({ [stage("history.json")]: "h", [stage("timeline.json")]: "t", [stage("base.json")]: "b" });
  const r = promoteSnapshots({ steps: STEPS, staging: "stage", dataDir: "data", fs });
  ok("base.json is promoted", r.updated.includes("base.json"), JSON.stringify(r.updated));
  ok("timeline.json is promoted", r.updated.includes("timeline.json"));
  ok("it lands in data/", fs.files.get(data("base.json")) === "b");
  ok("nothing is missing", r.missing.length === 0, JSON.stringify(r.missing));

  /* The counter-check. This is the exact list the old code iterated, and it is why base.json
   * never reached data/ on CI. If promoteSnapshots used it too, the assertion above fails. */
  const oldWay = STEPS.flatMap((s) => s.outputs || []);
  ok(
    "the outputs-only list the old code used would have skipped base.json",
    !oldWay.includes("base.json"),
    JSON.stringify(oldWay)
  );
}

console.log("\nan optional output that was not produced is reported, not fatal");
{
  const fs = fakeFs({ [stage("timeline.json")]: "t" });
  const r = promoteSnapshots({ steps: STEPS, staging: "stage", dataDir: "data", fs });
  ok("the missing one is listed", r.missing.includes("base.json"), JSON.stringify(r.missing));
  ok("the rest still promote", r.updated.includes("timeline.json"));
  ok("and it is not an error", r.updated.length === 1);
}

console.log("\nidentical bytes are not rewritten");
{
  const fs = fakeFs({ [stage("timeline.json")]: "same", [data("timeline.json")]: "same" });
  const r = promoteSnapshots({ steps: STEPS, staging: "stage", dataDir: "data", fs });
  ok("counted as unchanged", r.unchanged.includes("timeline.json"), JSON.stringify(r.unchanged));
  ok("nothing counted as updated", r.updated.length === 0, JSON.stringify(r.updated));
  ok("the .incoming temp file is cleaned up", fs.calls.remove.length === 1, JSON.stringify(fs.calls.remove));
  ok("and never renamed over the target", fs.calls.rename.length === 0);
}

console.log("\nchanged bytes are renamed into place, never written in place");
{
  const fs = fakeFs({ [stage("timeline.json")]: "new", [data("timeline.json")]: "old" });
  const r = promoteSnapshots({ steps: STEPS, staging: "stage", dataDir: "data", fs });
  ok("counted as updated", r.updated.includes("timeline.json"), JSON.stringify(r.updated));
  ok("the new bytes are in data/", fs.files.get(data("timeline.json")) === "new");
  ok(
    "the copy target is a .incoming sibling, so a reader never sees a half-written file",
    fs.calls.copy[0][1] === data("timeline.json") + ".incoming",
    JSON.stringify(fs.calls.copy)
  );
}

console.log("\nevery step is visited, in order");
{
  const fs = fakeFs({ [stage("history.json")]: "h", [stage("timeline.json")]: "t", [stage("base.json")]: "b" });
  const r = promoteSnapshots({ steps: STEPS, staging: "stage", dataDir: "data", fs });
  ok(
    "all three files promote in step order",
    JSON.stringify(r.updated) === JSON.stringify(["history.json", "timeline.json", "base.json"]),
    JSON.stringify(r.updated)
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
await process.stdout.write("");
process.exit(fail ? 1 : 0);
