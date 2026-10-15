---
name: backend-testing
description: A backend Jest run is slow, hanging, segfaulting, running out of memory, or reporting a socket hang up; or you need TEST_DB_SLOT, a second jest process, or coverage numbers.
user-invocable: false
---

# Backend testing operations

The backend suite runs against a real Postgres, one database per Jest worker. Most confusing
failures are infrastructure, not the spec that reported them. Read the matching section of
`references/troubleshooting.md` before changing a test.

## Run the right thing

```bash
npx jest tests/<path>/<file>.test.ts     # one spec, the default for a change
npx jest --findRelatedTests <files>      # the specs covering what you changed
npm run test:coverage                    # coverage, never a bare npx jest --coverage
```

**Never run the full `npm test` unless the user explicitly asks.** It is memory-heavy on this
machine, though no longer slow: about 750 suites in the `unit` project, a few minutes on four workers. A single spec or
`--findRelatedTests` is still the expected verification for a change.

## Symptom index

| Symptom | Section in `references/troubleshooting.md` |
|---|---|
| Suite got dramatically slower over weeks | Postgres WAL growth. A `CHECKPOINT` took a 514 s run down to 64 s |
| Specs fail with connect timeouts, dropped connections or unexplained 500s | `pg_class` bloat starving the checkpointer. `vacuum full pg_class` per test database took the cluster from 600 MB to 140 MB and turned 56 failures green |
| Host runs out of memory, container dies | Container memory and the `maxWorkers` lever |
| Bare "socket hang up" from an unrelated spec | Four separate causes, none of them that spec |
| Jest worker exits with SIGSEGV | A Node bug, not your code |
| Need a second jest process beside the suite | `TEST_DB_SLOT` and the shared slot pool |
| Passing `--testPathIgnorePatterns` broke the run | It replaces the project value rather than adding to it |
| Coverage percentage moved without new tests | Measure with `npm run test:coverage`; `db:coverage-scope-check` guards the denominator |
| Many 429s in a run | Rate limits. Count them before trusting the result, and wait about 90 seconds between full runs |

## Before trusting a green test

Break the code the test claims to protect and watch it fail. A test that passes on broken code
covers nothing. `test-driven-development/testing-anti-patterns.md` lists the four shapes that
recur here.
