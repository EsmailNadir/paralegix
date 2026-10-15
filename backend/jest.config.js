// Two suites live here, and they have opposite requirements.
//
//   unit  Everything under tests/ except tests/live. Pure-function specs plus
//         the in-process specs that drive the real Express app through supertest
//         with Firebase and the mail transport mocked (tests/support). No server,
//         no network, no credentials, so this is what CI runs and what `npm test`
//         means. Each worker owns its own Postgres database, so it parallelises.
//
//   live  tests/live: the original black-box suite. It fetches a real server on
//         :5001, signs in to real Firebase, and shares one seeded account, so it
//         is serial, rate-limited, and cannot run without credentials. Kept
//         because it is the only thing that exercises the deployed wiring end to
//         end, but it is opt-in: `npm run test:live`.
//
// The transform is shared. It deliberately does NOT use ts-jest's `js-with-ts`
// preset: an explicit `transform` replaces a preset's transform map wholesale, so
// pairing the two would leave the preset doing nothing while looking load-bearing.
const shared = {
  testEnvironment: 'node',
  rootDir: __dirname,
  transform: {
    // Transpile-only. The switch lives in tsconfig.test.json's `isolatedModules`;
    // see the note there for why it is required rather than an optimisation.
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    // The suite itself holds no .js files (the ratchet is 0). This entry exists
    // for the handful of node_modules packages un-ignored below, and routing
    // them through ts-jest rather than adding babel keeps the dependency list
    // unchanged -- `allowJs` is already on and `checkJs` already off, so they
    // are downleveled to CommonJS without being type-checked.
    '^.+\\.js$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // `sanitize-html` reaches htmlparser2, which ships ESM only ("type": "module",
  // no CommonJS build). The app is fine -- Node 22+ can `require()` an ES module
  // -- but Jest's own CommonJS module runtime cannot, so importing anything that
  // touches the sanitizer failed to even parse. Transforming just that subtree
  // makes those modules loadable under test; everything else in node_modules is
  // still skipped, which is what keeps the transform cheap.
  transformIgnorePatterns: [
    '/node_modules/(?!(htmlparser2|domhandler|domutils|dom-serializer|domelementtype|entities)/)',
  ],
};

module.exports = {
  // Native coverage preserves functions serialized into browser contexts.
  coverageProvider: 'v8',
  // Root level, not inside a project: Jest reads `testTimeout` from the top-level
  // config only, so a value set per project is silently ignored and every spec
  // falls back to the 5s default. 30s because the first in-process spec pays for
  // loading the whole 445-file app graph, and under --coverage that graph is
  // instrumented on the way in, which pushes the first request past 5s.
  // 120s, not 30s. The GitHub runner has 4 vCPU and runs four Jest workers plus
  // the Postgres container on them, so a spec that seeds heavily takes several
  // times as long there as on a developer machine. Three suites
  // (contactDirectory, taskListReads, outlookSync) blew the old 30s inside a
  // beforeAll hook and reported "Exceeded timeout of 30000 ms for a hook",
  // which reads as a broken test rather than a slow one.
  //
  // Raising this does NOT risk a hung run going unnoticed any more: the test
  // pool now carries lock_timeout=10s (tests/support/db.ts) so a blocked
  // truncate fails loudly, and the CI job carries timeout-minutes.
  testTimeout: 120000,
  // Capped, and read at the ROOT because Jest ignores maxWorkers inside a
  // project block the same way it ignores testTimeout there.
  //
  // Not a performance knob. It is bounded by the Podman Postgres this suite runs
  // against, which has `max_connections` 100 and a 6 GiB memory limit.
  //
  // Each worker loads the app, opens its own pool alongside the fixture pool, and
  // connects to its OWN database, so it carries its own relcache for all 110
  // tables. Memory therefore scales with worker count, not just connection count.
  //
  // History, because the number looks arbitrary otherwise. Letting Jest scale to
  // the cpu count put ~13 workers on the container and Postgres was OOM-killed
  // (`checkpointer process was terminated by signal 9`). Four workers then held
  // at 512 MiB up to ~670 tests and stopped holding at ~830, crashing into
  // recovery a second time. The container went to 2 GiB, which lasted until
  // ~1200 tests, and then to 4 GiB, which sat at 89% once `PG_POOL_MAX` went to
  // 10 and produced a THIRD failure mode: a Jest worker killed with SIGSEGV,
  // which looks nothing like a memory problem.
  //
  // The container is now on 6 GiB:
  //     podman update --memory 6g --memory-swap 6g paralegix-pg
  //
  // That takes effect live, without a restart.
  //
  // MEASURED, because an earlier version of this comment guessed and was wrong.
  // It claimed Postgres `anon` "peaks far below the limit" and that `podman
  // stats` was mostly reclaimable page cache. The cgroup says otherwise under a
  // full run: anon 3.26 GiB, file (cache) 1.64 GiB, slab 1.53 GiB. The anon half
  // is genuinely resident. Read it yourself with:
  //     podman exec paralegix-pg cat /sys/fs/cgroup/memory.stat | grep -E '^(anon|file|slab) '
  //
  // What drives anon is `PG_POOL_MAX` (10, in tests/support/db.ts) times the
  // worker count: forty backends, each carrying its own relcache for all 110
  // tables. Lowering the pool would shrink it, and reintroduces the socket
  // hang-ups the pool was raised to fix, so it stays.
  //
  // A SIGSEGV on a Jest worker, with NO `signal 9` in the Postgres log, is the
  // HOST running out of memory rather than the container: an 18 GiB machine had
  // ~58 MiB free mid-run, with four Node workers at ~2 GiB and the Postgres VM
  // at 4.15 GiB. Dropping to three workers does not fix it and costs 25% wall
  // clock. Close other memory-hungry applications instead.
  //
  // If a fresh checkout OOM-kills Postgres, the container is still on an older
  // limit: raise it with the command above rather than lowering this.
  //
  // `test:live` overrides this to 1 on the command line, because that suite
  // drives one shared account against one server.
  maxWorkers: 4,
  // A worker keeps the whole app graph loaded and reuses that process across
  // every spec file it is handed, so its heap only ever grows across a 400-file
  // run. One worker died with "Jest worker ran out of memory and crashed" on an
  // otherwise clean run, taking its spec file's cases with it and reporting as a
  // failure in whichever file it happened to be holding.
  //
  // This restarts a worker whose heap is above the limit BETWEEN files, never
  // mid-file, so it costs one app reload rather than a lost suite. 1GB is well
  // above what a single file needs (the graph settles around 300MB) and well
  // below what four workers plus the Postgres container can claim on a laptop.
  workerIdleMemoryLimit: '1GB',
  projects: [
    {
      ...shared,
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/**/*.test.ts'],
      testPathIgnorePatterns: ['<rootDir>/tests/live/'],
    },
    {
      ...shared,
      displayName: 'live',
      testMatch: ['<rootDir>/tests/live/**/*.test.ts'],
      globalSetup: '<rootDir>/tests/live/global-setup.ts',
    },
  ],
  // Coverage is only meaningful for the in-process suite; the live suite runs
  // against a separate process this one cannot instrument.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/shared/database/drizzle/schema.ts',
  ],
};
