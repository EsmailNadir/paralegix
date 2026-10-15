// PreToolUse(Bash) guard. Reads the tool call on stdin; exit 2 to BLOCK with a message.
//
// The match is against the RAW command string, so it also blocks a harmless command that merely
// quotes one of these patterns. Write that content through a file rather than inline.
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const { tool_input } = JSON.parse(input || "{}");
  const cmd = (tool_input && tool_input.command) || "";
  const danger = [
    [/\brm\s+-rf?\b/, "recursive delete"],
    [/\bgit\s+push\b.*--force\b/, "force push"],
    [/\bgit\s+reset\s+--hard\b/, "hard reset"],
    [/:\(\)\s*\{.*\}\s*;:/, "fork bomb"],
    // GitHub Actions is manual dispatch only. The account's Actions budget is capped at $0, so an
    // unscheduled run burns the free-tier allowance and gets killed mid-job. Verify locally.
    [/\bgh\s+workflow\s+(run|enable)\b/, "GitHub Actions dispatch"],
    [/\bgh\s+run\s+(rerun|watch)\b/, "GitHub Actions re-run"],
    // Production is a separate, much older codebase. No tooling in this repo may target it.
    [/\bDB_TARGET\s*=\s*["']?prod\b/, "production database target"],
    [/--allow-prod\b/, "production override flag"],
    [/\bapply-schema[^|;&]*--reset\b/, "schema reset"],
  ];
  const hit = danger.find(([re]) => re.test(cmd));
  if (hit) {
    console.error(
      `Blocked by guard-bash (${hit[1]}): "${cmd}". This is a policy block, not a tool failure ` +
        `or a permissions problem. Confirm with the user instead of rephrasing around it.`
    );
    process.exit(2); // non-zero blocks the command
  }
  process.exit(0);
});
