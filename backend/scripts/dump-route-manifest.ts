/**
 * Print every route the Express app registers, as a stable manifest.
 *
 * The proof that a route refactor changed nothing. Rewriting 437 handlers to a
 * shared wrapper touches the one thing no unit test asserts directly: that each
 * route is still mounted at the same path, for the same method, behind the same
 * number of middleware. A handler quietly dropped from the chain, or a path that
 * gained a segment, is invisible to a service-level test and obvious in a diff of
 * this output.
 *
 *   npx tsx scripts/dump-route-manifest.ts > before.txt
 *   ...refactor...
 *   npx tsx scripts/dump-route-manifest.ts > after.txt
 *   diff before.txt after.txt
 *
 * Middleware are counted, not named: they are anonymous closures once mounted, so
 * a name would be `<anonymous>` for most of the chain and prove nothing. The count
 * still catches a lost `verifyToken` or `requirePermission`.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.RBAC_ENFORCED = 'true';
process.env.RATE_LIMITS_DISABLED = 'true';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/paralegix_manifest_unused';

/** One route: where it sits in the mount tree, and how many things run before it. */
interface RouteEntry {
  /** Index path through the mount tree, e.g. `4.2` for the third route of the fifth router. */
  position: string;
  method: string;
  /** The path as declared on its own router, which is the only form Express 5 keeps. */
  path: string;
  middleware: number;
}

/**
 * Express 5 replaced each layer's `regexp` with an opaque `matchers` function and
 * keeps `path` undefined for a mounted router, so a full URL cannot be
 * reconstructed from the stack any more.
 *
 * Position in the mount tree stands in for it. Route registration in `app.ts` and
 * in every module router is static, so the traversal order is deterministic: the
 * same code produces the same manifest every time. That is all a before/after
 * diff needs. A route that moves, changes method, or loses a middleware shows up;
 * so does one that disappears, because every later entry shifts position.
 */
function walk(stack: any[], position: string, out: RouteEntry[]): void {
  (stack ?? []).forEach((layer, index) => {
    const here = position ? `${position}.${index}` : String(index);

    if (layer.route) {
      const methods = Object.keys(layer.route.methods ?? {}).filter((m) => layer.route.methods[m]);
      for (const method of methods.sort()) {
        out.push({
          position: here,
          method: method.toUpperCase(),
          path: layer.route.path,
          middleware: layer.route.stack?.length ?? 0,
        });
      }
      return;
    }

    const nested = layer.handle?.stack;
    if (Array.isArray(nested)) walk(nested, here, out);
  });
}

const app = require('../src/app');
const router = app.router ?? app._router;
const routes: RouteEntry[] = [];
walk(router?.stack ?? [], '', routes);

for (const route of routes) {
  console.log(`${route.position.padEnd(14)} ${route.method.padEnd(7)} ${route.path}  [${route.middleware}]`);
}
console.error(`${routes.length} routes`);
