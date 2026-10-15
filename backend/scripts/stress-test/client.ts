import type { TokenSource } from './auth';
import type { Sample } from './stats';

/** Longer than the API's 40s write timeout, so the server's answer is what gets recorded. */
const REQUEST_TIMEOUT_MS = 60_000;
// Document queues can outlive the ordinary write deadline. Match the browser's
// upload budget so the report records the server's answer instead of aborting it.
const DOCUMENT_TIMEOUT_MS = 300_000;
const DOCUMENT_STEP = /^(esign|templates)\./;

export interface ApiResponse {
  status: number;
  body: any;
}

/** A step did not return the success the flow needs, so this iteration stops here. */
export class StepFailed extends Error {}

export function requireOk(res: ApiResponse, step: string, accept: number[] = [200, 201]): any {
  if (!accept.includes(res.status)) {
    const detail = res.body && typeof res.body === 'object' && res.body.code ? ` ${res.body.code}` : '';
    throw new StepFailed(`${step} returned ${res.status}${detail}`);
  }
  return res.body;
}

const parseBody = (text: string): any => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * One virtual user's connection to the API. Every call is timed and recorded as
 * a Sample, success or not, so the report sees exactly what the user saw.
 */
export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly tokens: TokenSource,
    private readonly samples: Sample[],
  ) {}

  async call(name: string, method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = { 'X-Timezone': 'America/New_York' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false) headers.Authorization = `Bearer ${await this.tokens.token()}`;
    return this.timed(name, () => fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(DOCUMENT_STEP.test(name) ? DOCUMENT_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
    }));
  }

  /** PUTs bytes straight to a storage upload URL, as the browser does. */
  async upload(name: string, url: string, bytes: Buffer, contentType: string): Promise<ApiResponse> {
    return this.timed(name, () => fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    }));
  }

  private async timed(name: string, send: () => Promise<Response>): Promise<ApiResponse> {
    const started = performance.now();
    let status = 0;
    let body: any = null;
    try {
      const res = await send();
      status = res.status;
      body = parseBody(await res.text());
    } catch {
      status = 0;
    }
    const code = body && typeof body === 'object' && typeof body.code === 'string' ? body.code : null;
    this.samples.push({ name, status, ms: performance.now() - started, code });
    return { status, body };
  }
}
