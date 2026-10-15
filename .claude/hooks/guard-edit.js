// PreToolUse(Edit|Write|MultiEdit) guard. Reads the tool call on stdin; exit 2 to BLOCK.
//
// Two rules:
//   1. No em-dash (U+2014) in source, styles, config or published docs pages.
//      Markdown under .claude/ is exempt: it is agent-facing and already contains many.
//   2. No Edit of an existing numbered migration. An applied migration is immutable; correct it
//      with a new numbered file (which is a Write, and stays allowed).
const path = require("path");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    process.exit(0); // never break the session on a parse problem
  }
  const name = payload.tool_name || "";
  const ti = payload.tool_input || {};
  const file = ti.file_path || "";
  if (!file) process.exit(0);

  const rel = path.relative(process.env.CLAUDE_PROJECT_DIR || process.cwd(), file);

  // --- rule 2: applied migrations are immutable ---
  if (name !== "Write" && /^backend\/db\/migrations\/.+\.sql$/.test(rel)) {
    console.error(
      `Blocked by guard-edit: ${rel} is a numbered migration. Never edit or replay an applied ` +
        `migration. Add a new numbered migration instead (use /new-migration).`
    );
    process.exit(2);
  }

  // --- rule 1: no em-dashes ---
  const guarded =
    /\.(ts|tsx|js|jsx|sql|css|json)$/.test(rel) ||
    (/^docs\//.test(rel) && /\.md$/.test(rel));
  if (!guarded) process.exit(0);

  const added = []
    .concat(ti.new_string ? [ti.new_string] : [])
    .concat(ti.content ? [ti.content] : [])
    .concat(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string || "") : []);

  if (added.some((t) => t.includes("—"))) {
    console.error(
      `Blocked by guard-edit: the change introduces an em-dash into ${rel}. Reword with a period, ` +
        `a comma or a colon. See .claude/rules/no-em-dashes.md.`
    );
    process.exit(2);
  }
  process.exit(0);
});
