import { buildReport } from '../../../scripts/stress-test/report';
import { docPipelineSummary, formatTable, percentile, summarize, type Sample } from '../../../scripts/stress-test/stats';

const s = (name: string, ms: number, status = 200, code: string | null = null): Sample => ({ name, ms, status, code });

describe('percentile (nearest rank)', () => {
  const tens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('returns the value at the nearest rank', () => {
    expect(percentile(tens, 50)).toBe(50);
    expect(percentile(tens, 95)).toBe(100);
    expect(percentile(tens, 90)).toBe(90);
  });

  it('handles one sample and none', () => {
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('summarize', () => {
  it('groups by step, counts network failures and 4xx/5xx as errors, and sorts slowest p95 first', () => {
    const rows = summarize([
      s('fast', 10), s('fast', 20),
      s('slow', 900), s('slow', 1000, 503, 'TEMPLATE_FILL_BUSY'), s('slow', 50, 0),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['slow', 'fast']);
    expect(rows[0]).toEqual({
      name: 'slow', count: 3, errors: 2, p50: 900, p95: 1000, max: 1000,
      statuses: { '200': 1, '503 TEMPLATE_FILL_BUSY': 1, '0': 1 },
    });
    expect(rows[1].errors).toBe(0);
  });
});

describe('docPipelineSummary', () => {
  it('counts only document steps and keeps busy apart from other server errors', () => {
    const summary = docPipelineSummary([
      s('core.dashboard', 5, 503),
      s('templates.fillPdf', 30000, 503, 'TEMPLATE_FILL_BUSY'),
      s('templates.exportPdf', 100, 429, 'RATE_LIMITED'),
      s('esign.complete', 60000, 0),
      s('esign.convertFinalize', 200, 503, 'CONVERSION_FAILED'),
      s('esign.generate', 120),
    ]);
    expect(summary).toEqual({ calls: 5, busy: 1, rateLimited: 1, timeouts: 1, serverErrors: 1 });
  });
});

describe('formatTable', () => {
  it('renders one markdown row per step with rounded milliseconds', () => {
    const table = formatTable(summarize([s('core.matters.list', 12.4), s('core.matters.list', 30.6)]));
    expect(table).toContain('| core.matters.list | 2 | 0 | 12 | 31 | 31 | 200: 2 |');
  });
});


it.each(['CONVERSION_BUSY', 'SIGNING_BUSY'])('classifies %s as load refusal rather than a converter crash', (code) => {
  expect(docPipelineSummary([
    s('esign.convertFinalize', 500, 503, code),
    s('templates.fillPdf', 900, 503, 'TEMPLATE_FILL_BUSY'),
    s('esign.generate', 100, 503, 'MAINTENANCE_MODE'),
  ])).toEqual({ calls: 3, busy: 2, rateLimited: 0, timeouts: 0, serverErrors: 1 });
});

it('describes all document busy codes and the document timeout budget in the report', () => {
  const report = buildReport({ target: 'http://localhost:5001', users: 1, durationSec: 60, profile: 'docs-burst', burstRounds: 1 }, 1, [
    s('esign.convertFinalize', 100, 503, 'CONVERSION_BUSY'),
    s('esign.complete', 100, 503, 'SIGNING_BUSY'),
    s('templates.fillPdf', 100, 503, 'TEMPLATE_FILL_BUSY'),
    s('templates.fillPdf', 300_000, 0),
  ], [], 300_000);
  expect(report).toContain('**Document queue busy (503):** 3');
  expect(report).toContain('**No response within 300s:** 1');
  expect(report).toContain('**Other 5xx:** 0');
});
