/**
 * Render benchmark for the shared list/picker primitives.
 *
 * Two things are checked here that ordinary unit tests do not cover:
 *
 * 1. HOW LONG a real React render takes for the sizes these controls actually
 *    see in production (a 1000-option dropdown, a 50-row list page, a picker
 *    resolving 50 selected ids). The full table is reported for eyeballing, and
 *    each scenario also carries a loose upper bound (see BUDGET_MS). jsdom is
 *    several times slower than a browser because every style and layout call is
 *    JavaScript, so treat the numbers as a relative signal between runs, not as
 *    an absolute user-facing latency.
 *
 * 2. HOW MANY option rows re-render while the filter is typed. That one IS
 *    asserted, because it is a correctness property rather than a speed
 *    measurement. The hover and fresh-options row counts, and the EntityPicker
 *    lookup behaviour, are unit tests that run in `npm test`:
 *    `tests/components/ui/DropdownRendering.test.tsx` and
 *    `tests/components/ui/EntityPickerLookup.test.tsx`.
 *
 * Row renders are counted without touching the component: each option object
 * exposes `label` as a getter, and the only place `label` is read during a
 * render is the row itself (the trigger reads it too, but only for the selected
 * option, and these cases run unselected).
 */

import React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../setup";

const mockLookupMatters = jest.fn();
const mockLookupClients = jest.fn();

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    lookupMatters: (...args: unknown[]) => mockLookupMatters(...args),
  },
}));

jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: unknown[]) => mockLookupClients(...args),
  },
}));

import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import EntityMultiPicker from "@/components/ui/EntityMultiPicker";
import ListView, { type ListRow } from "@/components/ui/ListView";
import { DROPDOWN_MAX_RENDERED } from "@/lib/constants/search";

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

const SAMPLES = 7;
const WARMUPS = 2;

/**
 * Upper bound per scenario, in milliseconds of React work (the profiler's
 * `actualDuration` summed over the commits in the measured window), asserted
 * against the MEDIAN of the samples. Never a single sample: one run can be
 * three times the median when a GC lands inside the window, and a threshold
 * tight enough to be useful would flake on that alone.
 *
 * React time rather than wall clock, because the async scenarios spend most of
 * their wall time in `waitFor` polling for a mocked promise, which is test
 * harness latency and would swamp any real regression.
 *
 * HOW THESE WERE CHOSEN. Baselines came from two machines. Idle, across five
 * runs, the medians ranged: Dropdown open 8.2 to 9.8, hover 2.8 to 3.3, filter
 * typing 8.4 to 11.4, EntityPicker 1.8 to 2.4, ListView 9.2 to 27.9,
 * EntityMultiPicker 18.3 to 41.7. Under load the same scenarios reached
 * Dropdown open 9.9, hover 3.3, EntityPicker 8.0, ListView 46.3,
 * EntityMultiPicker 68.7. Each budget sits at roughly 3x the worst figure seen
 * for that scenario, so a heavily loaded CI machine has room while a genuine 5x
 * regression trips it on either machine.
 *
 * A third machine (16-core Windows) then measured roughly 2x those figures
 * across the board: idle medians of Dropdown open 19.6 to 20.8, hover 6.4 to
 * 9.8, filter typing 80.2 to 112.1, EntityPicker 12.7 to 14.6, ListView 57.0 to
 * 95.5, EntityMultiPicker 102.0 to 108.2, with Dropdown open reaching 45.7 and
 * filter typing 125.2 while a test server shared the CPU. Two budgets were
 * raised for it: Dropdown open, which had no headroom left for a loaded run,
 * and filter typing, whose original figure was never reachable (see below).
 *
 * The filter-typing baseline of 8.4 to 11.4 does not survive scrutiny: that
 * scenario renders a 100-row menu nine times over, so it cannot cost the same
 * as a single `Dropdown open` that renders those 100 rows once. It was recorded
 * while the menu re-rendered all 100 rows on every keystroke, so the honest
 * figure for the work it does is the one above. The wasted row renders are now
 * gone (`selectOption` no longer closes over `visibleOptions`), which cut the
 * scenario by ~2.6x, and the row-render count is asserted directly in that test
 * so the regression is caught by a deterministic count rather than by a clock.
 *
 * These are regression guards, not latency targets. If one starts failing, the
 * first question is what changed in the component, not whether the number needs
 * raising. Retune by running `npm run test:perf` a few times on an idle machine
 * and re-deriving from the new medians the same way, and update the baselines
 * above so the next engineer can do the same.
 */
const BUDGET_MS = {
  "Dropdown open (1000 options)": 60,
  "Dropdown hover re-render (1000 options)": 20,
  "Dropdown filter typing, 9 keystrokes (1000 options)": 300,
  "EntityPicker mount + open + 20 results": 40,
  "ListView server mode (50-row page)": 150,
  "EntityMultiPicker (50 selected + 20 results)": 220,
} as const;

type Scenario = keyof typeof BUDGET_MS;

interface Sample {
  /** Wall clock across the measured window, including any async settle time. */
  wallMs: number;
  /** React's own work: the sum of `actualDuration` over the commits in the window. */
  reactMs: number;
  /** Commits React made inside the window. */
  commits: number;
}

const results: Array<{
  scenario: string;
  wallMedianMs: number;
  reactMedianMs: number;
  reactMinMs: number;
  reactMaxMs: number;
  commits: number;
}> = [];

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Wraps a tree in a `React.Profiler` and accumulates `actualDuration` per commit.
 *
 * Wall clock alone overstates the async scenarios: waiting for a mocked query to
 * resolve is polling latency in `waitFor`, not rendering. The profiler total is
 * the part that would still cost something in a browser.
 */
function makeProfiler() {
  const state = { total: 0, commits: 0 };
  const wrap = (children: React.ReactNode) => (
    <React.Profiler
      id="bench"
      onRender={(_id, _phase, actualDuration) => {
        state.total += actualDuration;
        state.commits += 1;
      }}
    >
      {children}
    </React.Profiler>
  );
  return { state, wrap, reset: () => { state.total = 0; state.commits = 0; } };
}

/**
 * Runs `body` once per sample (after discarding warmup runs, which pay for
 * first-time module and JIT costs) and records the medians.
 */
async function measure(scenario: Scenario, body: () => Promise<Sample> | Sample) {
  const samples: Sample[] = [];
  for (let i = 0; i < WARMUPS + SAMPLES; i += 1) {
    const sample = await body();
    cleanup();
    if (i >= WARMUPS) samples.push(sample);
  }
  const reactSamples = samples.map((s) => s.reactMs);
  const reactMedianMs = median(reactSamples);
  results.push({
    scenario,
    wallMedianMs: median(samples.map((s) => s.wallMs)),
    reactMedianMs,
    reactMinMs: Math.min(...reactSamples),
    reactMaxMs: Math.max(...reactSamples),
    commits: median(samples.map((s) => s.commits)),
  });

  // Asserted inside `measure` so every scenario is covered by construction: the
  // `Scenario` type means a new one cannot be added without a budget. The
  // message carries the individual samples, because the first thing to know on a
  // failure is whether the whole distribution moved or one sample blew up.
  const budget = BUDGET_MS[scenario];
  if (reactMedianMs > budget) {
    throw new Error(
      `${scenario}: median React render ${reactMedianMs.toFixed(1)}ms exceeds the ${budget}ms budget. ` +
        `Samples: ${reactSamples.map((s) => s.toFixed(1)).join(", ")}ms. See BUDGET_MS in this file.`,
    );
  }
  expect(reactMedianMs).toBeLessThanOrEqual(budget);
}

/**
 * Options whose `label` read is counted. Used both as ordinary option data and
 * as the render counter for the memoization check.
 */
function countingOptions(count: number, prefix = "Client") {
  const counter = { reads: 0 };
  const options: DropdownOption[] = Array.from({ length: count }, (_, i) => {
    const label = `${prefix} ${i}`;
    return {
      value: `c${i}`,
      get label() {
        counter.reads += 1;
        return label;
      },
    };
  });
  return { options, counter };
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// ---------------------------------------------------------------------------

describe("render performance", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupClients.mockReset();
    mockLookupMatters.mockResolvedValue({ items: [], hasMore: false });
    mockLookupClients.mockResolvedValue({ items: [], hasMore: false });
  });

  afterAll(() => {
    const rows = results.map((r) => ({
      Scenario: r.scenario,
      "React ms (median)": r.reactMedianMs.toFixed(1),
      "React ms (min)": r.reactMinMs.toFixed(1),
      "React ms (max)": r.reactMaxMs.toFixed(1),
      "Wall ms (median)": r.wallMedianMs.toFixed(1),
      Commits: r.commits,
      "Budget ms": BUDGET_MS[r.scenario as Scenario],
    }));
    console.table(rows);
  });

  it("opens a 1000-option Dropdown with the rendered rows capped", async () => {
    let renderedRows = 0;

    await measure("Dropdown open (1000 options)", () => {
      const { options } = countingOptions(1000);
      const prof = makeProfiler();
      render(prof.wrap(<Dropdown value="" onChange={() => {}} options={options} />));
      const trigger = screen.getByRole("button");

      // The closed trigger is already painted; only the open is measured.
      prof.reset();
      const start = performance.now();
      fireEvent.click(trigger);
      const wallMs = performance.now() - start;

      renderedRows = screen.getAllByRole("option").length;
      return { wallMs, reactMs: prof.state.total, commits: prof.state.commits };
    });

    expect(renderedRows).toBe(DROPDOWN_MAX_RENDERED);
    expect(renderedRows).toBe(100);
  });

  it("measures a hover re-render across 1000 options", async () => {
    let rowRenders = -1;

    await measure("Dropdown hover re-render (1000 options)", () => {
      const { options, counter } = countingOptions(1000);
      const prof = makeProfiler();
      render(prof.wrap(<Dropdown value="" onChange={() => {}} options={options} />));
      fireEvent.click(screen.getByRole("button"));

      const rows = screen.getAllByRole("option");
      expect(rows).toHaveLength(DROPDOWN_MAX_RENDERED);

      // Everything up to here is the initial paint; only the hover is counted.
      counter.reads = 0;
      prof.reset();

      const start = performance.now();
      // The menu seeds its active option at index 0, so hovering row 50 changes
      // exactly two rows: 0 goes inactive, 50 goes active.
      fireEvent.mouseEnter(rows[50]);
      const wallMs = performance.now() - start;

      rowRenders = counter.reads;
      return { wallMs, reactMs: prof.state.total, commits: prof.state.commits };
    });

    // The exact count is pinned in tests/components/ui/DropdownRendering.test.tsx;
    // this only guards that the measured hover did re-render the rows.
    expect(rowRenders).toBeGreaterThan(0);
  });

  it("filters 1000 options as a term is typed", async () => {
    let matchCount = 0;
    let rowRenders = -1;

    const terms = ["C", "Cl", "Cli", "Clie", "Clien", "Client", "Client ", "Client 2", "Client 24"];

    await measure("Dropdown filter typing, 9 keystrokes (1000 options)", () => {
      const { options, counter } = countingOptions(1000);
      const prof = makeProfiler();
      render(prof.wrap(<Dropdown value="" onChange={() => {}} options={options} />));
      fireEvent.click(screen.getByRole("button"));
      const search = screen.getByRole("searchbox");

      prof.reset();
      counter.reads = 0;
      const start = performance.now();
      // One change event per character, the way typing actually arrives.
      for (const term of terms) {
        fireEvent.change(search, { target: { value: term } });
      }
      const wallMs = performance.now() - start;

      // Each keystroke scans all 1000 labels to build the match list; anything
      // beyond that is a row that re-rendered.
      rowRenders = counter.reads - terms.length * 1000;
      matchCount = screen.getAllByRole("option").length;
      return { wallMs, reactMs: prof.state.total, commits: prof.state.commits };
    });

    // "Client 24" plus "Client 240".."Client 249".
    expect(matchCount).toBe(11);

    // The memoization property for the FILTER path, asserted the same way the
    // hover case is: a correctness invariant, not a timing measurement.
    //
    // Only two of the nine keystrokes actually change the visible slice. "C"
    // through "Client " all leave the same 100 rows on screen (every label
    // starts with that prefix), so those rows must not re-render at all;
    // "Client 2" swaps in a new 100 and "Client 24" narrows to 11.
    //
    // This trips if `selectOption` (or any other row prop) goes back to
    // closing over `visibleOptions`, which takes a new identity on every
    // keystroke and re-renders all 100 rows per character even when the list
    // on screen is unchanged.
    expect(rowRenders).toBe(100 + 11);
  });

  it("mounts, opens and renders a 20-item EntityPicker result", async () => {
    mockLookupMatters.mockResolvedValue({
      items: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, label: `Matter ${i}` })),
      hasMore: false,
    });

    let optionCount = 0;

    await measure("EntityPicker mount + open + 20 results", async () => {
      const client = makeQueryClient();
      const prof = makeProfiler();
      const start = performance.now();
      render(
        <QueryClientProvider client={client}>
          {prof.wrap(
            <EntityPicker entity="matters" lawFirmId="firm-1" value="" onChange={() => {}} />
          )}
        </QueryClientProvider>
      );
      fireEvent.click(screen.getByRole("button"));
      await waitFor(() => expect(screen.getAllByRole("option").length).toBe(20));
      const wallMs = performance.now() - start;

      optionCount = screen.getAllByRole("option").length;
      client.clear();
      return { wallMs, reactMs: prof.state.total, commits: prof.state.commits };
    });

    expect(optionCount).toBe(20);
  });

  it("renders a 50-row server-mode ListView page", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `row-${i}`,
      name: `Matter ${i}`,
      client: `Client ${i}`,
      status: i % 2 ? "open" : "closed",
      amount: i * 137,
    }));

    const renderRow = (row: (typeof rows)[number]): ListRow => ({
      title: row.name,
      badges: <span>{row.status}</span>,
      meta: `${row.client} · ${row.status}`,
      right: <span>{row.amount}</span>,
    });

    let footerText = "";

    await measure("ListView server mode (50-row page)", () => {
      const prof = makeProfiler();
      const start = performance.now();
      render(
        prof.wrap(<ListView
          rows={rows}
          getRowId={(row) => row.id}
          renderRow={renderRow}
          paginationMode="server"
          page={0}
          pageSize={50}
          // A firm-wide total far larger than the page, so the footer has to
          // report `rowCount` rather than the number of rows it holds.
          rowCount={1234}
          onPageChange={() => {}}
          onPageSizeChange={() => {}}
          pageSizeOptions={[10, 25, 50]}
          defaultPageSize={50}
          showSelection
          selectionModel={[]}
          onSelectionChange={() => {}}
        />)
      );
      const wallMs = performance.now() - start;
      footerText = screen.getByText(/of 1234/).textContent ?? "";
      return { wallMs, reactMs: prof.state.total, commits: prof.state.commits };
    });

    // The page slice on screen is the 50 rows handed in, while the count line
    // reflects the server's total.
    expect(footerText.replace(/\s/g, "")).toBe("1–50of1234");

    render(
      <ListView
        rows={rows}
        getRowId={(row) => row.id}
        renderRow={renderRow}
        paginationMode="server"
        page={0}
        pageSize={50}
        rowCount={1234}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        pageSizeOptions={[10, 25, 50]}
        defaultPageSize={50}
      />
    );
    // Server mode renders the page it was handed verbatim: no client-side slice
    // on top of the server's, which would drop rows off the end of the page.
    expect(screen.getByText("Matter 0")).toBeInTheDocument();
    expect(screen.getByText("Matter 49")).toBeInTheDocument();
    expect(screen.queryByText("Matter 50")).not.toBeInTheDocument();
  });

  it("renders an EntityMultiPicker holding 50 selections plus 20 results", async () => {
    const selectedIds = Array.from({ length: 50 }, (_, i) => `m${i}`);

    // Chunked id resolution and the search share one mock; `ids` requests answer
    // with the chunk they asked for, search requests with a fresh 20.
    mockLookupMatters.mockImplementation((_firmId: string, params: { ids?: string[] }) => {
      if (params?.ids?.length) {
        return Promise.resolve({
          items: params.ids.map((id) => ({ id, label: `Selected ${id}` })),
          hasMore: false,
        });
      }
      return Promise.resolve({
        items: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, label: `Result ${i}` })),
        hasMore: true,
      });
    });

    let rowCount = 0;

    await measure("EntityMultiPicker (50 selected + 20 results)", async () => {
      const client = makeQueryClient();
      const prof = makeProfiler();
      const start = performance.now();
      render(
        <QueryClientProvider client={client}>
          {prof.wrap(
            <EntityMultiPicker
              entity="matters"
              lawFirmId="firm-1"
              selectedIds={selectedIds}
              onChange={() => {}}
            />
          )}
        </QueryClientProvider>
      );
      await waitFor(() => expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(70));
      const wallMs = performance.now() - start;

      rowCount = screen.getAllByRole("button").length;
      client.clear();
      return { wallMs, reactMs: prof.state.total, commits: prof.state.commits };
    });

    // 50 pinned selections + 20 search results.
    expect(rowCount).toBe(70);
  });
});
