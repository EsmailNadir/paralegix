/**
 * Vercel's image optimizer stays off.
 *
 * The only remote images the app shows are firm logos, and their src is a
 * signed storage link that changes whenever the API signs it again. The
 * optimizer keys its cache on the URL, so every new signature made it fetch and
 * resize the same logo again, against Vercel's monthly transformation quota, to
 * serve a 44 px image. With it off, `next/image` hands the browser the link as
 * it is, which is also what keeps a future `<Image>` of a signed link from
 * quietly bringing the cost back.
 */
import nextConfig from "../../next.config";

describe("next.config images", () => {
  it("does not route images through the optimizer", () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });

  it("no longer allowlists storage hosts for it", () => {
    // Only meaningful to the optimizer. Left behind, it reads as though images
    // from storage were still being transformed.
    expect(nextConfig.images?.remotePatterns).toBeUndefined();
  });
});
