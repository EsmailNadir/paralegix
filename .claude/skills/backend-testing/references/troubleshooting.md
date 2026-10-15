# Backend test suite troubleshooting

Moved verbatim from `backend/AGENTS.md`. Each block is a measured incident, not advice.

**The test container still runs PRODUCTION durability settings, and that is the single
biggest thing slowing this suite down.** Measured on a healthy machine:

| | |
|---|---|
| `pg_wal` | **19 GB**, 1160 segments |
| `base` (the actual data) | **1.3 GB** |
| `max_wal_size` | **1 GB** |

Nineteen times the configured ceiling. Check the obvious retention causes first and
expect them to be clean, because they were here: `archive_mode` off, no replication
slots, `wal_keep_size` 0. Nothing is HOLDING the WAL.

`max_wal_size` is a soft target, not a limit. Postgres only recycles WAL at a
checkpoint, and this suite emptied ~103 tables with `truncate` between every spec across four
workers, so it generates WAL far faster than fsynced checkpoints can retire it. The
segments pile up until something forces a checkpoint.

A manual `CHECKPOINT` reclaims the space:

```bash
podman exec paralegix-pg psql -U postgres -c "checkpoint;"
```

Measured on a machine that had reached this state. The checkpoint itself took over
ten minutes, which is the same work the suite pays for continuously, concentrated
into one command:

| | before | after |
|---|---|---|
| `pg_wal` | 19 GB, 1160 segments | **1.1 GB, 66 segments** |
| full suite | **514 s** | **64 s** |

An eight-fold speedup from a maintenance command, with no code change.

THE GROWTH RATE, so you know when to run it: roughly **350 MB of WAL per full suite
run**, and the run time degrades measurably as it accumulates.

| `pg_wal` | full suite |
|---|---|
| 1.1 GB | 64 s |
| 2.5 GB | 85 s |

At that rate it reaches the 19 GB state in around fifty runs. Checkpoint every
twenty or so, or remove the cause below and stop thinking about it.

The durability settings are why the checkpoints cannot keep up. They are correct for
production and wrong for a database that is disposable and rebuilt from `schema.sql`
by `npm run test:db`.

What the container reports today:

```
fsync              | on
synchronous_commit | on
full_page_writes   | on
wal_level          | replica
max_wal_size       | 1024
```

Turning the first three off is the standard fix for a write-heavy test database, and
all three are reloadable without a restart:

```bash
podman exec paralegix-pg psql -U postgres -c \
  "alter system set fsync = off; \
   alter system set synchronous_commit = off; \
   alter system set full_page_writes = off;"
podman exec paralegix-pg psql -U postgres -c "select pg_reload_conf();"
```

Reverse it with `alter system reset <name>` and another reload. `wal_level = minimal`
would help further but needs a restart, which costs several minutes of startup fsync.

THE RISK, STATED PLAINLY: with `fsync` off, an unclean container stop can corrupt the
test databases. That is acceptable here and nowhere else. These databases are rebuilt
with one command and hold no real data. NEVER apply any of this to a container that
also serves the local development database.

Symptoms that point at this rather than at memory: a full run taking several minutes
instead of ~80 seconds, `du` or `df` inside the container timing out, and a transient
`could not create file "base/...": No space left on device` from `truncateAll` while
both filesystems report hundreds of gigabytes free.

**`pg_class` bloats until a checkpoint cannot finish, and every spec starts failing as if the
code were broken.** `setup-test-db.sh` runs `drop schema public cascade; create schema public`
and reapplies `schema.sql` on each of the six test databases. That is ~1100 catalog rows created
and dead-rowed per database per rebuild, and autovacuum does not reclaim the space, so `pg_class`
grows without bound across weeks of rebuilds. Measured here:

| | before | after |
|---|---|---|
| `paralegix_test_6` | 292 MB | **18 MB** |
| of which `pg_class` | 274 MB | negligible |
| tables in it | 101 | 101 |
| whole cluster | ~600 MB | **~140 MB** |

A bloated `pg_class` is dirtied by every truncate, so each checkpoint has to fsync it along with
a huge fsync-request backlog. The checkpoint log is where this is visible, and the number to look
at is `sync`, not `write`:

```
checkpoint complete: wrote 3849 buffers (23.5%); write=269.386 s, sync=748.165 s,
total=1037.876 s; sync files=1197227
```

Seventeen minutes, of which twelve are fsync, for 30 MB of buffers. While one of these runs the
pool cannot get connections, and specs fail with `timeout exceeded when trying to connect`,
`Connection terminated unexpectedly` and `Cannot use a pool after calling end on the pool`. Those
surface as HTTP 500 from routes that are fine: the billing suite reported 56 unexplained 500s and
went to 44 suites and 805 tests green after the reclaim, with no code change.

The fix is one maintenance command per database, and it is NOT `vacuum` (which cannot return the
space) or `npm run test:db` (which recreates the tables inside the same bloated catalog):

```bash
podman exec paralegix-pg psql -U postgres -d paralegix_test_1 -c "vacuum full pg_class"
```

`vacuum full` takes an ACCESS EXCLUSIVE lock, so run it with no suite in flight. Repeat per
database. Distinguishing this from the WAL problem above: the WAL problem shows up as `pg_wal`
far over `max_wal_size`, this one as a database far larger than its table count justifies. Both
can be present at once, and a `CHECKPOINT` issued while `pg_class` is bloated inherits the same
twelve-minute fsync, which looks like the checkpoint itself hanging.

Note that the documented `fsync = off` remedy above is unavailable on a container that also hosts
the local development database, which this one does. Reclaiming the catalog is not blocked by
that, and on this machine it was worth more.

**The between-spec reset is `DELETE`, not `TRUNCATE`, and that is load-bearing.** `truncate`
allocates a new relfilenode for every table and index it touches, and each one is a `pg_class`
row update. Measured on this schema: `tests/auth` alone, eight spec files, grew `pg_class` from
400 kB to 7.9 MB. Over a full 451-file run that is hundreds of megabytes of catalog per worker
database, the checkpointer has to fsync every file, and checkpoints stretched past five minutes
while every query queued behind them. `tests/support/db.ts` now deletes under
`session_replication_role = replica`, which suppresses the trust ledger's append-only trigger and
the internal foreign-key triggers, so it stays equivalent to `truncate ... cascade`. Catalog
growth per run went to zero and the billing directory went from an estimated 226s to 15s.

If the catalog has already bloated from an older run, `vacuum full pg_class` per database
reclaims it; see the section above.

**A worker can die with "Jest worker ran out of memory and crashed."** Distinct from the
SIGSEGV below: this one is an ordinary heap exhaustion, and it reports as a failure in
whichever spec file the worker was holding. A worker keeps the whole app graph loaded and
reuses that process across every file it is handed, so its heap only grows across a 400-file
run. `jest.config.js` carries `workerIdleMemoryLimit: '1GB'`, which restarts such a worker
BETWEEN files rather than losing one mid-file.

**Give the Postgres container at least 6 GiB.** `maxWorkers: 4` means four workers each running
`truncate` over ~103 tables between spec files, which took an ACCESS EXCLUSIVE lock on every
one of them at once. At 2 GiB the container was OOM-killed repeatedly, and 4 GiB ran at ~89% once `PG_POOL_MAX` went to 10 (more connections means more per-backend memory), which showed up as a Jest worker dying with SIGSEGV:

```
LOG: checkpointer process (PID ...) was terminated by signal 9: Killed
LOG: all server processes terminated; reinitializing
```

The symptom is NOT an obvious crash. Postgres restarts and spends several minutes in recovery
("the database system is in recovery mode"), and runs on either side of it fail in ways that look
like application bugs: a fixture that inserted a firm gets a 404 from the next request, or a spec
that passes alone fails in the full suite. If a test flakes only under full-suite load, check
`podman logs paralegix-pg` for signal 9 before hunting in the app.

```bash
podman update --memory 6g --memory-swap 6g paralegix-pg
```

That takes effect live, without restarting the container. Idle databases cost nothing at rest, so
the extra ones `setup-test-db.sh` may have built are not the problem; the concurrent resets
are.

**If the full suite is using too much memory on the host, `maxWorkers: 4` is the lever, and it can
be cut per-run without touching this repo's config.** Three separate memory costs stack during a
full run: the Postgres container itself (capped above), the Podman machine VM (`podman machine
inspect --format '{{.Resources.Memory}}'` prints its ceiling in MiB, fixed at `podman machine init
--memory` and not by this repo), and the 4 Jest worker Node processes running directly on the host
outside the VM (each
one measured several hundred MB to ~900 MB RSS during a real run). Fewer workers cuts all three at
once: fewer concurrent Postgres connections, fewer simultaneous ACCESS EXCLUSIVE truncates, and
fewer Node processes.

```bash
npm test -- --maxWorkers=2     # roughly half the peak memory, roughly double the wall time
npm test -- --runInBand        # one worker; slowest, lowest peak memory
```

Neither of `package.json`'s `test`/`test:unit`/`test:coverage` scripts hardcodes `--maxWorkers`, so
a CLI flag overrides `jest.config.js`'s `maxWorkers: 4` for that invocation only. Don't lower
`maxWorkers` in `jest.config.js` itself as a permanent fix: CI's `backend-tests` job reads the same
file, so that change would also cut CI's parallelism, not just a local run's memory footprint.

**The container clock drifts, and it fails as anything but a clock problem.** The `podman
machine` VM loses time under sustained load: measured at 15 minutes lost across a 31-minute
full run, and 58 minutes lost after the host had been busy for a while. The VM's hardware
clock stays correct throughout; it is the system clock that stalls.

Nothing in the failure text says "clock". Postgres stamps `created_at` from its own `now()`
and the app compares that against Node's `Date.now()`, so once the gap exceeds a window the
app enforces, work that just happened is refused as too old. At 58 minutes behind, seven
messaging specs failed on "Messages can only be edited within 30 minutes of sending" for a
message created milliseconds earlier.

`tests/support/setupInProcess.ts` checks the gap once per worker and fails with the cause
and the remedy rather than letting it surface as hundreds of unrelated assertions. For a
one-off correction, which takes effect immediately and does not stop the container:

```bash
podman machine ssh 'sudo hwclock -s'
```

**The standing fix is `chronyd`, and it is already applied.** `systemd-timesyncd` cannot
handle this: it lets the poll interval stretch to 34 minutes and only slews, which the
kernel caps near 10 percent, so against a loss of this size it reports
"System clock synchronized: yes" while sitting 24 minutes out. `chronyd` was installed but
inactive because timesyncd held the clock. The VM now runs chronyd instead, with
`/etc/chrony.d/paralegix-vm-drift.conf`:

```
makestep 0.5 -1
server time.cloudflare.com iburst minpoll 4 maxpoll 6
```

`makestep 0.5 -1` steps on any update rather than only the first three (the stock config is
`makestep 1.0 3`), and the 16-to-64 second poll keeps each correction small. Measured across
a full suite run afterwards: 1 second of drift, against 898 before.

Do NOT substitute a `hwclock -s` on a short timer. Stepping a database's clock every 45
seconds while the suite runs is worse than the drift itself: it took a run from 103 failing
suites to 275, with hooks timing out.

If the VM is ever recreated, this drop-in goes with it and has to be written again. The
symptom to recognise is the guard's message.

---

**If a spec fails with a bare "socket hang up", it is almost never that spec.** Four separate
causes have produced it, all infrastructural, and all of them move around as the suite grows:

0. **A fresh ephemeral port per request.** This was the dominant one and is now fixed.
   `supertest(app)` given an Express handler binds a NEW server on port 0 for every single
   call and closes it after. The suite makes tens of thousands of those per worker, which
   outruns the kernel's recycling of ports out of TIME_WAIT, and a request occasionally
   connects to a port whose previous server has gone. The client then reads nothing, or
   reads bytes that are not a status line, and reports `socket hang up` or
   `Parse Error: Expected HTTP/, RTSP/ or ICE/`. `tests/support/app.ts` now hands supertest
   one ALREADY LISTENING server per worker, which supertest reuses instead of binding its
   own. Measured over twelve runs of `tests/auth tests/billing`: four failures before, none
   after. `tests/support/app.test.ts` fails if the per-request form comes back.
1. **A module-load timer firing mid-run.** The app is loaded once per Jest worker, so anything
   scheduled at import time fires inside whatever spec file happens to be running when the delay
   elapses. It then does database work against a pool that file is about to close, or after Jest
   has torn the environment down. `unref()` stops a timer holding the event loop open; it does
   NOT stop it firing. `shareNotifications.startupSweep()` (10s) and the `emailWhitelist` refresh
   (every 15s) both did this and are now skipped when `NODE_ENV` is test.
2. **Pool exhaustion.** Several services fan out with `Promise.all`, so one request can hold four
   connections at once. `PG_POOL_MAX` is 10 here for that reason; at the app's minimum of 5 the
   next concurrent query waited on the pool long enough to die.
3. **Postgres being OOM-killed**, per the section above.

Check `podman logs paralegix-pg` for signal 9 first, then look for a timer, before hunting in the
application code.

**A jest worker dying with SIGSEGV is a Node bug, not yours.** This is the fourth
distinct cause and the only one nothing in this repo can fix. The symptom is a whole
spec file reporting `Test suite failed to run` with

```
A jest worker process (pid=...) was terminated by another process: signal=SIGSEGV
```

and the run's TOTAL test count dropping, because that file's cases never ran. It moves
between files, so it reads as a problem with whichever spec drew the short straw.

Confirm it from the crash report rather than guessing. macOS writes one per crash:

```bash
ls -t ~/Library/Logs/DiagnosticReports/node-*.ips | head
```

Every crash observed here has the identical top frame, and no application frame appears
anywhere on the stack:

```
v8::internal::ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers
v8::internal::MarkCompactCollector::MarkRoots
v8::internal::Heap::CollectGarbage
```

That is V8's garbage collector walking its own roots. Twelve crashes in fifteen hours on
Node v24.18.0, all the same signature. Nothing in `src/` or `tests/` is on the stack, so
there is no test to fix and no fixture to blame.

**This is now handled.** Disabling concurrent marking stops it. The flag cannot go in
`NODE_OPTIONS` (node refuses it there), so it is passed to the binary, and `test`,
`test:unit`, `test:coverage` and `test:watch` in `backend/package.json` all spell it out:

```bash
node --no-concurrent-marking node_modules/.bin/jest --selectProjects unit
```

The earlier note here recorded four clean runs and called that suggestive rather than
conclusive, which was right: at a one-in-three failure rate four clean runs happen by
chance about one time in five. It has since been measured over twenty-two runs of
`tests/auth tests/billing` with zero crashes. Under the same null that is a probability of
about 0.00017, so the flag is doing the work rather than the dice.

A bare `npx jest <file>` does NOT carry the flag. That is deliberate and safe: a single
spec finishes long before enough garbage accumulates to trip the bug, and every crash
observed here was in a long run. If a single spec ever segfaults, run it through
`npm test -- <file>` instead.

That only filters because every test script closes its `--selectProjects unit` list with
`--passWithNoTests=false`. `--selectProjects` takes a list, so without a flag after it a path
appended by `npm test -- <file>` became a second project name and all 523 specs ran.
`tests/config/testScripts.test.ts` fails if a script loses that. The same trap catches
`jest --selectProjects unit <file>` typed by hand: put the path first, or end the list.

CI is unaffected either way. It runs Node 22 (`.github/workflows/ci.yml`, and `node:22-slim`
in `backend/cloudbuild.yaml`, matching `engines: node >= 22`); this machine runs Node 24,
which is where the bug lives. That gap is worth closing separately.

**`TEST_DB_SLOT` runs a second jest process alongside the suite.** Jest overwrites
`JEST_WORKER_ID` in every process it owns, `--runInBand` included, so exporting that
variable does not give a concurrent run its own database: both land on
`paralegix_test_1` and each truncates the other's fixtures mid-file. The failures look
like application bugs, because a fixture that inserted a firm gets a 404 from the next
request.

`TEST_DB_SLOT` takes precedence over the worker id, so:

```bash
TEST_DB_SLOT=5 npx jest tests/<path>/<file>.test.ts --runInBand
```

**`--testPathIgnorePatterns` on the command line REPLACES the project's own value.** The `unit`
project excludes `tests/live/` through that key, so a run that passes the flag to skip something
else silently un-excludes the live suite. It then tries to sign in to real Firebase against a
server on :5001 and reports hundreds of failures that look like application breakage. Seen
2026-08-31: excluding three in-progress specs turned a 175-suite run into a 221-suite run with 51
failed suites, every one of them under `tests/live/`. Repeat the live pattern in the flag:

```bash
npx jest --selectProjects unit --testPathIgnorePatterns "/node_modules/" "/tests/live/" "<yours>"
```

Slots 1 to 4 belong to the suite's own workers (`maxWorkers: 4`); use 5 and up for
anything running beside it. Build the extra databases with
`TEST_DB_COUNT=10 ./scripts/setup-test-db.sh` (the count comes from the environment
variable, not from a positional argument). Idle databases cost nothing at rest.

**Multiple agents running isolated tests must share one small slot pool, not each
pick a fresh number.** Seen 2026-09-01: a multi-agent session where each of ~20
parallel subagents chose its own never-reused `TEST_DB_SLOT` (55, 65, 75, 95, 105,
115...) left 177 test databases on the container by the end. No single agent did
anything wrong in isolation, and idle databases are genuinely free on their own,
but that many concurrent agents each independently running their own Node/Jest
process — on top of the full suite's own 4 workers, if one happened to run at the
same time — starved the HOST machine's memory, not just the container's, and
killed an in-progress full-suite run outright. Fixes, both required when dispatching
several agents that each need an isolated backend test run:
- **Reuse slots 5 through 20**, cycling through that fixed range instead of
  incrementing past whatever the last agent used. Check what is actually free first
  (`podman exec paralegix-pg psql -U postgres -t -c "select datname from pg_database
  where datname like 'paralegix_test_%'"`) rather than guessing a new number.
- **Never start a full `npm test` run while other agents' isolated test runs are
  still active.** The full suite is tuned for exactly 4 concurrent workers, not "4
  plus whatever else happens to be running." Wait for other agents to finish first.
- Drop a slot's database when the agent's task is done if nothing else will reuse
  it soon (`drop database if exists "paralegix_test_<slot>"`), so the pool does not
  grow unbounded across a long session.

Separate databases fix the DATA collision, not the SOURCE one. Mutation testing
edits `src/` in place, and every concurrent process reads the same working tree,
so a full-suite run started while another process has a line mutated reports
failures that belong to that mutation. This is not subtle when you look for it:
the failing test names match the mutated rule exactly. It cost a round of
diagnosis here, on four signing tests that turned out to be a concurrent turn-check
mutation, and all seven passed once the source was whole. Check `git status` for a
modified file under `src/` before trusting a full-suite failure.

`RATE_LIMITS_DISABLED=true` makes every limiter inert. It is keyed on that variable rather than on
`NODE_ENV` on purpose: `tests/shared/rateLimiters.test.ts` exists to assert that a limiter rejects
at its cap, and Jest sets `NODE_ENV=test` for it too.

**Measure coverage with `npm run test:coverage`, never a bare `npx jest --coverage`.**
There are two Jest projects and a bare `npx jest` runs BOTH. The `live` project needs a
real server and real Firebase credentials, so its global setup throws, the run exits
non-zero before a single test executes, and NO coverage summary is written. The previous
`coverage/coverage-summary.json` is left on disk, so anything that reads the file
afterwards gets whatever the last successful run produced. Redirecting the command's
output hides the failure completely.

That is not hypothetical. It silently produced coverage figures eight hours out of date
here, and those figures then drove the choice of what to test next. If a percentage looks
unchanged after you have added tests, check the file's mtime before believing it.

```bash
npm run test:coverage            # jest --selectProjects unit --coverage
```

