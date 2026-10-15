/**
 * Latency and error accounting for a stress run. Every HTTP call the harness
 * makes becomes one Sample; everything in the report is derived from them.
 */
export interface Sample {
  name: string;
  /** HTTP status, or 0 when the request never got one (timeout, reset, DNS). */
  status: number;
  ms: number;
  /** The `code` field of an API error body, when there was one. */
  code: string | null;
}

export interface Row {
  name: string;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  statuses: Record<string, number>;
}

export interface PipelineSummary {
  calls: number;
  busy: number;
  rateLimited: number;
  timeouts: number;
  serverErrors: number;
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export const isError = (sample: Sample): boolean => sample.status === 0 || sample.status >= 400;

export function summarize(samples: Sample[]): Row[] {
  const byName = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = byName.get(sample.name);
    if (list) list.push(sample);
    else byName.set(sample.name, [sample]);
  }
  const rows = [...byName].map(([name, list]) => {
    const ms = list.map((x) => x.ms).sort((a, b) => a - b);
    const statuses: Record<string, number> = {};
    for (const x of list) {
      const key = x.code ? `${x.status} ${x.code}` : String(x.status);
      statuses[key] = (statuses[key] || 0) + 1;
    }
    return {
      name,
      count: list.length,
      errors: list.filter(isError).length,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      max: ms[ms.length - 1],
      statuses,
    };
  });
  return rows.sort((a, b) => b.p95 - a.p95);
}

const DOC_STEP = /^(esign|templates)\./;
const BUSY_CODES = new Set(['TEMPLATE_FILL_BUSY', 'CONVERSION_BUSY', 'SIGNING_BUSY']);
const isBusy = (sample: Sample) => sample.status === 503 && BUSY_CODES.has(sample.code || '');

/**
 * How the document path held up: e-signature and template steps are the ones
 * that reach the document worker or the API's render gates.
 */
export function docPipelineSummary(samples: Sample[]): PipelineSummary {
  const doc = samples.filter((x) => DOC_STEP.test(x.name));
  return {
    calls: doc.length,
    busy: doc.filter(isBusy).length,
    rateLimited: doc.filter((x) => x.status === 429).length,
    timeouts: doc.filter((x) => x.status === 0).length,
    serverErrors: doc.filter((x) => x.status >= 500 && !isBusy(x)).length,
  };
}

export function formatTable(rows: Row[]): string {
  const header = '| Step | Calls | Errors | p50 ms | p95 ms | Max ms | Statuses |\n| --- | ---: | ---: | ---: | ---: | ---: | --- |';
  const lines = rows.map((r) => {
    const statuses = Object.entries(r.statuses).map(([k, v]) => `${k}: ${v}`).join(', ');
    return `| ${r.name} | ${r.count} | ${r.errors} | ${Math.round(r.p50)} | ${Math.round(r.p95)} | ${Math.round(r.max)} | ${statuses} |`;
  });
  return [header, ...lines].join('\n');
}
