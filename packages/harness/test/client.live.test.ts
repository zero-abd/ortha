import { describe, expect, it } from "vitest";
import { createOrthogonalClient } from "../src/client.js";

// Live smoke against the real api.orthogonal.com. SKIPPED unless ORTHO_TEST_KEY
// is set, so the normal suite stays hermetic and $0. It deliberately hits ONLY
// the free metadata endpoints (search + details) and never makes a paid /run
// call — verifying a real key still parses cleanly costs nothing.
//
//   ORTHO_TEST_KEY=orth_live_... bunx vitest run packages/harness/test/client.live.test.ts
//
// If these fail after passing before, the Orthogonal wire contract drifted —
// refresh the captured fixtures in harness.test.ts to match.

const KEY = process.env["ORTHO_TEST_KEY"];

describe.skipIf(!KEY)("live Orthogonal API smoke (free endpoints only)", () => {
  const client = createOrthogonalClient({ getApiKey: async () => KEY! });

  it("search returns results in the live (priceless) endpoint shape", async () => {
    const results = await client.search({ prompt: "scrape a webpage to markdown", limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0]?.slug).toBe("string");
    expect(results[0]?.endpoints.length).toBeGreaterThan(0);
  }, 20_000);

  it("getDetails returns a cents price derived from the numeric dollar amount", async () => {
    const results = await client.search({ prompt: "scrape a webpage to markdown", limit: 3 });
    const api = results[0]!;
    const ep = api.endpoints[0]!;
    const d = await client.getDetails(api.slug, ep.path);
    expect(d.priceCents).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(d.priceCents)).toBe(true);
    expect(["read", "write", "unknown"]).toContain(d.sideEffect);
  }, 20_000);
});
