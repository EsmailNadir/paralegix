import fs from 'fs';
import path from 'path';
import type { StressConfig } from './config';
import { docPipelineSummary, formatTable, isError, summarize, type Sample } from './stats';

export const REPORTS_DIR = path.join(__dirname, 'reports');

export function buildReport(config: StressConfig, users: number, samples: Sample[], failures: string[], elapsedMs: number): string {
  const errors = samples.filter(isError).length;
  const pipeline = docPipelineSummary(samples);
  const minutes = elapsedMs / 60_000;
  const failureCounts = new Map<string, number>();
  for (const f of failures) failureCounts.set(f, (failureCounts.get(f) || 0) + 1);
  const topFailures = [...failureCounts].sort((a, b) => b[1] - a[1]).slice(0, 15);

  return [
    `# Stress test: ${config.profile}`,
    '',
    `- **Target:** ${config.target}`,
    `- **Users:** ${users}`,
    `- **Elapsed:** ${minutes.toFixed(1)} min`,
    `- **Requests:** ${samples.length} (${Math.round(samples.length / Math.max(minutes, 1 / 60))}/min)`,
    `- **Errors:** ${errors} (${samples.length ? ((errors / samples.length) * 100).toFixed(1) : '0.0'}%)`,
    '',
    '## Document pipeline',
    '',
    `- **E-signature and template calls:** ${pipeline.calls}`,
    `- **Document queue busy (503):** ${pipeline.busy}`,
    `- **Rate limited (429):** ${pipeline.rateLimited}`,
    `- **No response within 300s:** ${pipeline.timeouts}`,
    `- **Other 5xx:** ${pipeline.serverErrors}`,
    '',
    '## Steps, slowest p95 first',
    '',
    formatTable(summarize(samples)),
    '',
    '## Flows that stopped early',
    '',
    topFailures.length ? topFailures.map(([msg, n]) => `- ${n}x ${msg}`).join('\n') : 'None.',
    '',
  ].join('\n');
}

export function writeReport(config: StressConfig, markdown: string, samples: Sample[]): string {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(REPORTS_DIR, `${stamp}-${config.profile}`);
  fs.writeFileSync(`${file}.md`, markdown);
  fs.writeFileSync(`${file}.json`, JSON.stringify(samples));
  return `${file}.md`;
}
