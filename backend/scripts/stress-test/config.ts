/**
 * Command-line options for the stress test, and the guard that keeps it off
 * production. A stress run is deliberately abusive traffic, so the target is an
 * allowlist rather than a denylist: a host that is not named here is refused,
 * including a raw Cloud Run URL that could belong to any environment.
 */
export type Profile = 'realistic' | 'docs-burst';

export interface StressConfig {
  target: string;
  users: number;
  durationSec: number;
  profile: Profile;
  burstRounds: number;
}

const STAGING_HOST = 'api-staging.paralegix.com';
export const ALLOWED_TARGET_HOSTS = [STAGING_HOST, 'localhost', '127.0.0.1'];

export function assertSafeTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (!ALLOWED_TARGET_HOSTS.includes(url.hostname)) {
    throw new Error(`Refusing to stress ${url.hostname}. Allowed hosts: ${ALLOWED_TARGET_HOSTS.join(', ')}.`);
  }
  if (url.hostname === STAGING_HOST && url.protocol !== 'https:') {
    throw new Error('Staging must be reached over https.');
  }
  return url.origin;
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const intInRange = (raw: string | undefined, fallback: number, min: number, max: number, name: string): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return n;
};

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): StressConfig {
  const profile = flag(argv, '--profile') ?? 'realistic';
  if (profile !== 'realistic' && profile !== 'docs-burst') {
    throw new Error(`Unknown --profile ${profile}. Use realistic or docs-burst.`);
  }
  return {
    target: assertSafeTarget(flag(argv, '--target') ?? env.STRESS_TARGET ?? `https://${STAGING_HOST}`),
    users: intInRange(flag(argv, '--users'), 10, 1, 50, '--users'),
    durationSec: intInRange(flag(argv, '--duration'), 300, 10, 3600, '--duration'),
    profile,
    burstRounds: intInRange(flag(argv, '--rounds'), 3, 1, 10, '--rounds'),
  };
}
