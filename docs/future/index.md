# Future

Forward-looking notes for the engineering team: what is planned, what is
deferred, and the known gaps we intend to close. This is a working document, not
a commitment or a public roadmap.

::: warning INTERNAL — NOT PUBLIC
This section is **excluded from the public documentation build**. It ships only
when the site is built with `DOCS_INCLUDE_DEV=true`, the same admin-only build
that exposes the [Dev](/dev/) section. Keep speculative or unreleased plans here,
never in the user guide.
:::

## Sections

- [Roadmap](/future/roadmap) — planned features and larger initiatives, grouped
  by rough priority.
- [Tech Debt & Known Gaps](/future/tech-debt) — deferred fixes, cleanups, and
  hardening work we know about but have not scheduled.
- [UI for Older Users: Modal Sizing, Buttons, Color and Type](/future/ui-for-older-users-research):
  external best practices for attorneys in their fifties and sixties, compared with the
  current frontend, with a prioritized action list.

## How to use this section

- Add an entry when you decide to defer work, not when you finish it. The point
  is to keep "we know about this" separate from "this is done."
- Link to the relevant [engineering reference](/features/README) or ops doc so a
  future reader can find the code, not just the intent.
- When an item ships, move the detail into the user guide or the engineering
  reference and delete it from here. This page should shrink as work lands.
