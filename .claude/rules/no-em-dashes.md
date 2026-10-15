# No em-dashes

Never write an em-dash (U+2014) in code, comments, UI copy, commit messages, or documentation
site pages under `docs/`. Reword with a period, a comma, or a colon instead.

A `PreToolUse` hook (`.claude/hooks/guard-edit.js`) blocks an edit that introduces one into a
`.ts`, `.tsx`, `.js`, `.jsx`, `.sql`, `.css` or `.json` file, or into ANY `.md` under `docs/`. That
last clause covers `docs/AGENTS.md` and `docs/CLAUDE.md` as well as the published site pages, so a
new sentence added to either of those is held to the rule even though both already contain
em-dashes from before the hook.

The hook checks only the text an edit ADDS, so an em-dash already in a file never blocks a later
edit to it. Existing em-dashes under `.claude/` are grandfathered and are not worth a cleanup pass;
the same is true of the ones in `backend/AGENTS.md`, `docs/AGENTS.md` and the `CLAUDE.md` titles.

Check `git diff` for one before saying a change is done.
