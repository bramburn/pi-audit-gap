/** One-shot: archive existing checklists for goals pi-goal-x no longer tracks as active. */
const fs = require("node:fs");
const path = require("node:path");
const { archiveDod, doneDir, pruneArchivedDods } = require(path.join(__dirname, "..", "dist", "dod.js"));

const cwd = process.argv[2];
const skip = new Set(process.argv.slice(3));
const auditDir = path.join(cwd, ".pi", "audit-gap");

const entries = fs.readdirSync(auditDir).filter((e) => {
  if (e === "done" || e === "queue") return false;
  if (skip.has(e)) return false;
  return fs.existsSync(path.join(auditDir, e, "dod.json"));
});

let archived = 0;
for (const goalId of entries) {
  if (archiveDod(cwd, goalId)) archived++;
}
const pruned = pruneArchivedDods(cwd);
console.log(JSON.stringify({ archived, skipped: [...skip], doneDir: doneDir(cwd), pruned }));
