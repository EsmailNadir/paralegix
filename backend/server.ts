// Entry point shim — delegates to src/server.ts.
// Keeps dev runtime and root module references working with zero config changes.
require('./src/server');

// The entry shim exports nothing; the empty export marks it as a module.
export {};
