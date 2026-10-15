/**
 * Stripe.js for a firm's connected account. Card payments are direct charges on
 * the firm's own account, so the card form must load Stripe.js with that
 * account, once per account.
 *
 * Red if the account is not passed, if a second card form reloads Stripe.js for
 * the same account, if two firms share one instance, or if a missing key tries
 * to load Stripe anyway.
 */
const mockLoadStripe = jest.fn();
jest.mock("@stripe/stripe-js", () => ({ loadStripe: (...args: unknown[]) => mockLoadStripe(...args) }));

const ORIGINAL_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

beforeEach(() => {
  jest.resetModules();
  mockLoadStripe.mockReset();
  mockLoadStripe.mockImplementation((_key: string, opts: { stripeAccount: string }) => Promise.resolve({ account: opts.stripeAccount }));
});

afterAll(() => {
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = ORIGINAL_KEY;
});

function load() {
  return require("@/lib/payments/stripeClient") as typeof import("@/lib/payments/stripeClient");
}

it("loads Stripe.js with the platform key on the firm's connected account", async () => {
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_platform";
  const { stripeForAccount } = load();

  await expect(stripeForAccount("acct_firm_a")).resolves.toEqual({ account: "acct_firm_a" });

  expect(mockLoadStripe).toHaveBeenCalledWith("pk_test_platform", { stripeAccount: "acct_firm_a" });
});

it("loads once per account and separately for another firm", async () => {
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_platform";
  const { stripeForAccount } = load();

  const first = stripeForAccount("acct_firm_a");
  const again = stripeForAccount("acct_firm_a");
  const other = stripeForAccount("acct_firm_b");

  expect(again).toBe(first);
  await expect(other).resolves.toEqual({ account: "acct_firm_b" });
  expect(mockLoadStripe).toHaveBeenCalledTimes(2);
});

it("gives no Stripe when the publishable key is not configured", async () => {
  delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const { stripeForAccount } = load();

  await expect(stripeForAccount("acct_firm_a")).resolves.toBeNull();
  expect(mockLoadStripe).not.toHaveBeenCalled();
});
