/**
 * No listeners.
 *
 * This module registered four, and every one of them was dead: CLIENT_CREATED
 * had an empty body marked "Future:", and CLIENT_UPDATED, CLIENT_DELETED and
 * MATTER_DELETED each awaited a handler in clients.service that had been
 * reduced to `{ /* no-op *\/ }` when the denormalized client copies were
 * removed. Deleting any of them left all 17 cases in
 * tests/events/deleteCascades.test.ts green, because they contributed nothing.
 *
 * What actually cleans up after a client or matter is deleted:
 *   - `matter_clients` and the rest go with the parent by ON DELETE CASCADE.
 *   - `deleteClientCascade` in clients.service unwinds a client's links itself.
 *   - files, billing, documentRequests, signatures and notifications each
 *     listen for these events in their OWN events files and do real work there.
 *
 * The file is kept, rather than deleted along with its `require` in app.ts, so
 * that a future client-side listener has an obvious home next to its siblings.
 */

// This module registers no listeners and exports nothing. The empty export
// marks it as a MODULE so its scope stays file-local, matching every other
// events file.
export {};
