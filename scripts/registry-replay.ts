/**
 * REGISTRY REPLAY — benchmark the TEST SUITE against bugs we have actually had.
 *
 *   bun scripts/registry-replay.ts            # score the suite
 *   bun scripts/registry-replay.ts --verbose  # also print each failing test
 *
 * For each replayable incident in evals/registry-replay.manifest.ts: re-introduce it, run the fast
 * gate, and record whether anything went red. Prints caught / replayable.
 *
 * SAFETY, because this edits real source files:
 *   · refuses to run on a dirty working tree, so a crash can never eat uncommitted work;
 *   · restores each file from an in-memory snapshot in a finally, after every case;
 *   · verifies `git diff --quiet` at the end and SHOUTS if the tree is not clean.
 * It never touches git state, never commits, and never deploys.
 */
import { $ } from "bun";
import { REPLAY_CASES } from "../evals/registry-replay.manifest";

const VERBOSE = process.argv.includes("--verbose");
const root = new URL("..", import.meta.url).pathname;

// A dirty tree makes "restore" ambiguous — we could not tell our edit from the owner's.
const dirty = (await $`git -C ${root} status --porcelain`.text()).trim();
if (dirty) {
  console.error("REFUSING: working tree is dirty. Commit or stash first — this script edits source files in place.");
  console.error(dirty.split("\n").slice(0, 10).map(l => `  ${l}`).join("\n"));
  process.exit(1);
}

type Row = { id: string; incident: string; caught: boolean; failures: string[]; note?: string };
const rows: Row[] = [];
const skipped = REPLAY_CASES.filter(c => !c.replayable);

for (const c of REPLAY_CASES) {
  if (!c.replayable) continue;
  const path = `${root}${c.file}`;
  const original = await Bun.file(path).text();

  const hits = original.split(c.find).length - 1;
  if (hits !== 1) {
    // Report rather than mutate: an anchor that drifted would otherwise silently test nothing, and
    // a case that quietly stops replaying is how a benchmark rots into a number nobody questions.
    rows.push({ id: c.id, incident: c.incident, caught: false, failures: [],
                note: `ANCHOR ${hits === 0 ? "NOT FOUND" : `MATCHED ${hits}x`} in ${c.file} — case did not run` });
    continue;
  }

  try {
    await Bun.write(path, original.replace(c.find, c.replace));
    const res = await $`bash ${root}scripts/test-fast.sh`.nothrow().quiet();
    const out = res.stdout.toString() + res.stderr.toString();
    const failures = [...out.matchAll(/^\(fail\) (.+?)(?: \[|$)/gm)].map(m => m[1]);
    rows.push({ id: c.id, incident: c.incident, caught: failures.length > 0, failures });
  } finally {
    await Bun.write(path, original);          // always, even on throw
  }
}

const after = (await $`git -C ${root} status --porcelain`.text()).trim();
if (after) {
  console.error("\n⚠️  TREE NOT CLEAN AFTER REPLAY — restore failed. Run `git checkout -- .` and investigate:");
  console.error(after.split("\n").map(l => `  ${l}`).join("\n"));
}

const ran = rows.filter(r => !r.note);
const caught = ran.filter(r => r.caught);
const pct = ran.length ? (caught.length / ran.length) * 100 : 0;

console.log("\nREGISTRY REPLAY — can the suite still catch bugs we have already had?\n");
for (const r of rows) {
  const mark = r.note ? "⚠" : r.caught ? "✓" : "✗";
  console.log(`  ${mark} ${r.id}`);
  console.log(`      ${r.incident}`);
  if (r.note) console.log(`      ${r.note}`);
  else if (r.caught && VERBOSE) console.log(`      caught by: ${r.failures.slice(0, 3).join(" | ")}${r.failures.length > 3 ? ` (+${r.failures.length - 3})` : ""}`);
  else if (!r.caught) console.log(`      NOT CAUGHT — the suite stayed green with this bug re-introduced`);
}
console.log(`\n  SCORE: ${caught.length}/${ran.length} replayed incidents caught (${pct.toFixed(0)}%)`);
if (rows.some(r => r.note)) console.log(`  ${rows.filter(r => r.note).length} case(s) did not run — fix the anchor, do not drop the case.`);
console.log(`\n  ${skipped.length} incident(s) deliberately NOT replayable:`);
for (const s of skipped) if (!s.replayable) console.log(`    · ${s.id} — ${s.why}`);
console.log(`\n  The denominator counts only what a deterministic code change can express. An`);
console.log(`  LLM-judgment failure belongs in evals/reviewer-recall.ts, not here.\n`);
process.exit(ran.length > 0 && caught.length === ran.length ? 0 : 1);
