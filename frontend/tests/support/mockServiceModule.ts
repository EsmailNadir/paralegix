/**
 * A `jest.mock` factory for a service module where a spec cares about a few
 * methods and every other one should resolve empty, the way `tests/setup.ts`
 * stubs a whole service.
 *
 * The named `overrides` answer both as named exports and on the default
 * export; any other property resolves `{}`. Call it through `require` inside
 * the factory, because `jest.mock` is hoisted above the file's imports:
 *
 *   jest.mock('@/services/clients.service', () =>
 *     require('../../support/mockServiceModule').mockServiceModule({
 *       getClient: async () => ({ id: 'client-1' }),
 *     }),
 *   );
 */
export function mockServiceModule(overrides: Record<string, unknown>) {
  const fallback = () => jest.fn().mockResolvedValue({});
  const service = new Proxy(overrides, {
    get: (target, prop) => (prop in target ? target[prop as string] : fallback()),
  });
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === '__esModule') return true;
        if (prop === 'default') return service;
        return prop in overrides ? overrides[prop as string] : fallback();
      },
    },
  );
}
