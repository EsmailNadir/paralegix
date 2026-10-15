# Implementation plans

The `writing-plans` skill writes a task-by-task plan here as
`YYYY-MM-DD-<feature-name>.md` before implementation starts.

Empty is the normal state. A plan describes work that has not shipped yet, so
once it has, the code is the source of truth and the plan becomes a second,
diverging account of it. Delete it when its phases are done, the same rule
`specs/README.md` states for design specs.

Anything in a finished plan still worth keeping belongs somewhere durable
first: an engineering reference in `docs/features/`, architecture or ops in
`docs/dev/`, a decision still outstanding in `docs/future/tech-debt.md`, or a
rule an agent must follow in `AGENTS.md` or `.claude/rules/`. Check what cites
the plan before deleting it, including source comments and test headers; four
of them pointed at the last batch and each was better off carrying the reasoning
itself.

`ALWAYS_EXCLUDE` in `.vitepress/config.ts` drops `superpowers/**` from every
build, so nothing in here is ever published.
