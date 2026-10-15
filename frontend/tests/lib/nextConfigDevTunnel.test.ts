/**
 * Serving the dev app through one public HTTPS tunnel (a phone testing a
 * wallet flow cannot reach localhost). With DEV_API_PROXY_TARGET set, the app
 * forwards /backend-api/* to the local API, so a single tunnel carries both;
 * DEV_ALLOWED_ORIGINS lets the tunnel's host load dev resources.
 *
 * Red if the proxy rewrite or the allowed dev origin stops being added when the
 * variables are set, or if either appears when they are not (a production build
 * must never proxy to a local address).
 */
type Rewrite = { source: string; destination: string };

async function loadConfig(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  try {
    let config: typeof import("../../next.config").default | undefined;
    jest.isolateModules(() => {
      config = require("../../next.config").default;
    });
    return config!;
  } finally {
    process.env = saved;
  }
}

describe("next.config dev tunnel", () => {
  it("proxies /backend-api to the local API and allows the tunnel host when configured", async () => {
    const config = await loadConfig({
      DEV_API_PROXY_TARGET: "http://localhost:5001/",
      DEV_ALLOWED_ORIGINS: "demo.ngrok-free.app, other.example",
    });

    const rewrites = (await config.rewrites!()) as Rewrite[];
    expect(rewrites).toContainEqual({
      source: "/backend-api/:path*",
      destination: "http://localhost:5001/api/:path*",
    });
    expect(config.allowedDevOrigins).toEqual(["demo.ngrok-free.app", "other.example"]);
  });

  it("adds neither when the variables are unset", async () => {
    const config = await loadConfig({ DEV_API_PROXY_TARGET: undefined, DEV_ALLOWED_ORIGINS: undefined });

    const rewrites = (await config.rewrites!()) as Rewrite[];
    expect(rewrites.some((r) => r.source.startsWith("/backend-api"))).toBe(false);
    // The PostHog proxy is still there, so the rewrites themselves were read.
    expect(rewrites.some((r) => r.source.startsWith("/ingest"))).toBe(true);
    expect(config.allowedDevOrigins).toBeUndefined();
  });
});
