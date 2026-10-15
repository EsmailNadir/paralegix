# Design specs

The `brainstorming` skill writes a validated design here as
`YYYY-MM-DD-<topic>-design.md` before implementation starts.

A spec describes work that has not shipped yet. Once the feature is built and
merged, the code is the source of truth and the spec becomes stale guidance,
so delete it rather than leaving it to contradict the implementation. Anything
worth keeping belongs in `docs/features/` (engineering reference) or
`docs/dev/` (architecture and ops) instead.

`ALWAYS_EXCLUDE` in `.vitepress/config.ts` drops `superpowers/**` from every
build, so nothing in here is ever published.
