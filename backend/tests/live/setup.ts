/**
 * Test setup - NO MOCKS. Tests hit the real running server.
 *
 * Before running tests: start your server with `npm run dev` (port 5001)
 * Then in another terminal:
 * TEST_FIREBASE_API_KEY=... TEST_EMAIL=... TEST_PASSWORD=... npm test
 */

export const BASE_URL = process.env.TEST_API_URL || 'http://localhost:5001';

/**
 * Makes an HTTP request to the real backend server.
 * @param {string} method - GET, POST, PUT, PATCH, DELETE
 * @param {string} path - API path (e.g., '/api/lawfirms')
 * @param {object} [options] - { body, token, headers }
 * @returns {Promise<{ status: number, body: any, headers: object }>}
 */
export async function apiRequest(method: any, path: any, options: {
  body?: any;
  token?: string;
  headers?: Record<string, string>;
} = {}) {
  const { body, token, headers: extraHeaders = {} } = options;

  const headers: any = {
    'Content-Type': 'application/json',
    'x-timezone': 'America/New_York',
    ...extraHeaders,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const fetchOptions: any = {
    method,
    headers,
  };

  if (body && method !== 'GET') {
    fetchOptions.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, fetchOptions);

  let responseBody;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    responseBody = await res.json();
  } else {
    responseBody = await res.text();
  }

  return {
    status: res.status,
    body: responseBody,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

// Shorthand helpers
export const api = {
  get: (path: any, opts: any) => apiRequest('GET', path, opts),
  post: (path: any, opts: any) => apiRequest('POST', path, opts),
  put: (path: any, opts: any) => apiRequest('PUT', path, opts),
  patch: (path: any, opts: any) => apiRequest('PATCH', path, opts),
  delete: (path: any, opts: any) => apiRequest('DELETE', path, opts),
};
