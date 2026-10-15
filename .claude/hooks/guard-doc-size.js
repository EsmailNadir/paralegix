// PreToolUse(Edit|Write|MultiEdit) guard: agent-facing docs may not grow past their budget.
//
// A line budget written in prose does not hold. It gets fixed, then drifts back, because nothing
// refuses the edit that crosses it. This does.
//
// It is a RATCHET, not a flat cap. An edit is allowed when the result is within budget, OR when
// the result is no longer than the file already is. So a file that is already over budget can
// still be repaired, reworded, or corrected. It just cannot get bigger.
//
// Run `node .claude/hooks/guard-doc-size.js --report` to see every budgeted file and its headroom.
const fs = require("fs");
const path = require("path");

const BUDGETS = [
  // [matcher, budget, where the overflow belongs]
  [(p) => /(^|\/)AGENTS\.md$/.test(p), 220,
    "move the area-specific part into .claude/rules/ with a paths: glob, or into a skill"],
  [(p) => /^\.claude\/rules\/[^/]+\.md$/.test(p), 220,
    "split it into a second rule with a narrower paths: glob"],
  [(p) => /^\.claude\/skills\/.+\/SKILL\.md$/.test(p), 500,
    "move detail into a references/ file beside the SKILL.md"],
];

const budgetFor = (rel) => {
  for (const [match, limit, remedy] of BUDGETS) if (match(rel)) return { limit, remedy };
  return null;
};

const countLines = (text) => (text === "" ? 0 : text.split("\n").length);

function applyEdit(base, edit) {
  const { old_string: oldS = "", new_string: newS = "", replace_all: all } = edit;
  if (oldS === "") return base;
  return all ? base.split(oldS).join(newS) : base.replace(oldS, newS);
}

// --report mode: audit every budgeted file on disk
if (process.argv.includes("--report")) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (e.name.endsWith(".md")) out.push(path.relative(root, full));
    }
    return out;
  };
  let over = 0;
  for (const rel of walk(root).sort()) {
    const b = budgetFor(rel);
    if (!b) continue;
    const n = countLines(fs.readFileSync(path.join(root, rel), "utf8"));
    const bad = n > b.limit;
    if (bad) over++;
    console.log(`${bad ? "OVER " : "ok   "} ${String(n).padStart(4)}/${b.limit}  ${rel}`);
  }
  console.log(over ? `\n${over} file(s) over budget.` : "\nAll budgeted docs are within budget.");
  process.exit(over ? 1 : 0);
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    process.exit(0); // never break a session on a parse problem
  }
  const name = payload.tool_name || "";
  const ti = payload.tool_input || {};
  const file = ti.file_path || "";
  if (!file) process.exit(0);

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const rel = path.relative(root, file).split(path.sep).join("/");
  const budget = budgetFor(rel);
  if (!budget) process.exit(0);

  let before = "";
  try {
    before = fs.readFileSync(file, "utf8");
  } catch {
    before = ""; // new file
  }

  let after;
  if (name === "Write") after = ti.content || "";
  else if (Array.isArray(ti.edits)) after = ti.edits.reduce(applyEdit, before);
  else after = applyEdit(before, ti);

  const now = countLines(before);
  const next = countLines(after);

  if (next <= budget.limit) process.exit(0); // within budget
  if (next <= now) process.exit(0); // already over, but this edit does not grow it

  console.error(
    `Blocked by guard-doc-size: this edit takes ${rel} to ${next} lines, past its ${budget.limit}-line budget` +
      (now > budget.limit ? ` (it is already at ${now})` : ` (it is at ${now})`) +
      `.\n\nThis is a policy block, not a tool failure. The budget exists because an always-loaded or ` +
      `whole-file-loaded doc costs context on every session that touches it, and a long one gets ` +
      `ignored rather than followed.\n\nTo proceed: ${budget.remedy}. Cutting something else in the ` +
      `same file to make room also works. An edit that shrinks the file is never blocked.`
  );
  process.exit(2);
});
