import { describe, expect, expectTypeOf, it } from "vitest";

import {
  readCommerceCatalog,
  type CommerceCatalog,
} from "../src/catalog.js";
import {
  createCommerceService,
  type CreateSessionInput,
  type PrepareRenewalInput,
  type PrepareSessionSettlementInput,
} from "../src/commerce-service.js";
import { createMemoryCommerceStore } from "../src/commerce-store.js";

const seller = "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY";
const platform = "BPFLoaderUpgradeab1e11111111111111111111111";
const referrer = "Vote111111111111111111111111111111111111111";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function catalogJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    payment: {
      currency: mint,
      decimals: 6,
      network: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      secretKey: "unit-test-secret-with-sufficient-entropy",
      realm: "Commerce Test",
    },
    premiumProducts: [
      {
        id: "premium-report",
        amountBaseUnits: "2500000",
        description: "Premium research report",
        recipient: seller,
      },
    ],
    marketplaceProducts: [
      {
        id: "marketplace-dataset",
        amountBaseUnits: "10000000",
        description: "Marketplace dataset",
        recipient: seller,
        splits: [
          { recipient: platform, amount: "1000000", memo: "Platform" },
          { recipient: referrer, amount: "500000", memo: "Referrer" },
        ],
      },
    ],
    meteredPlans: [
      {
        id: "metered-api",
        unitPriceBaseUnits: "9007199254740993",
        maxUnits: 10,
        sessionTtlSeconds: 3600,
        description: "Metered API usage",
        recipient: seller,
      },
    ],
    subscriptionPlans: [
      {
        id: "monthly-api",
        priceBaseUnits: "12000000",
        periodDurationMonths: 1,
        description: "Monthly API access",
        recipient: seller,
      },
    ],
    ...overrides,
  });
}

function makeCatalog(): CommerceCatalog {
  return readCommerceCatalog({ COMMERCE_CATALOG_JSON: catalogJson() });
}

function makeService(options: { now?: string; sessionId?: string } = {}) {
  const now = options.now ?? "2028-02-29T12:00:00.000Z";
  return createCommerceService({
    catalog: makeCatalog(),
    store: createMemoryCommerceStore(),
    now: () => new Date(now),
    generateSessionId: () => options.sessionId ?? "session-deterministic",
  });
}

describe("readCommerceCatalog", () => {
  it("parses server-owned premium, marketplace, metered, and subscription entries", () => {
    const catalog = makeCatalog();

    expect(catalog.premiumProducts.get("premium-report")?.payment).toMatchObject({
      amountBaseUnits: "2500000",
      recipient: seller,
      currency: mint,
    });
    expect(catalog.marketplaceProducts.get("marketplace-dataset")?.payment.splits).toEqual([
      { recipient: platform, amount: "1000000", memo: "Platform" },
      { recipient: referrer, amount: "500000", memo: "Referrer" },
    ]);
    expect(catalog.meteredPlans.get("metered-api")).toMatchObject({
      unitPriceBaseUnits: "9007199254740993",
      maxUnits: 10,
      sessionTtlSeconds: 3600,
    });
    expect(catalog.subscriptionPlans.get("monthly-api")).toMatchObject({
      priceBaseUnits: "12000000",
      periodDurationMonths: 1,
    });
  });

  it("requires catalog configuration", () => {
    expect(() => readCommerceCatalog({})).toThrow("COMMERCE_CATALOG_JSON");
  });

  it.each([
    ["invalid primary recipient", { premiumProducts: [{ id: "bad", amountBaseUnits: "1", description: "Bad", recipient: "bad" }] }],
    ["invalid split total", { marketplaceProducts: [{ id: "bad", amountBaseUnits: "5", description: "Bad", recipient: seller, splits: [{ recipient: platform, amount: "5" }] }] }],
    ["unsafe max units", { meteredPlans: [{ id: "bad", unitPriceBaseUnits: "1", maxUnits: Number.MAX_SAFE_INTEGER + 1, sessionTtlSeconds: 60, description: "Bad", recipient: seller }] }],
    ["unsafe session duration", { meteredPlans: [{ id: "bad", unitPriceBaseUnits: "1", maxUnits: 1, sessionTtlSeconds: Number.MAX_SAFE_INTEGER + 1, description: "Bad", recipient: seller }] }],
    ["unsafe plan duration", { subscriptionPlans: [{ id: "bad", priceBaseUnits: "1", periodDurationMonths: Number.MAX_SAFE_INTEGER + 1, description: "Bad", recipient: seller }] }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => readCommerceCatalog({ COMMERCE_CATALOG_JSON: catalogJson(overrides) })).toThrow();
  });

  it("rejects duplicate IDs across catalog categories", () => {
    expect(() =>
      readCommerceCatalog({
        COMMERCE_CATALOG_JSON: catalogJson({
          subscriptionPlans: [{
            id: "metered-api",
            priceBaseUnits: "1",
            periodDurationMonths: 1,
            description: "Duplicate",
            recipient: seller,
          }],
        }),
      }),
    ).toThrow("Duplicate catalog id");
  });
});

describe("metered sessions", () => {
  it("creates an active session with server-owned limits and ISO timestamps", async () => {
    const service = makeService();

    const session = await service.createSession({ accountId: "acct-1", planId: "metered-api" });

    expect(session).toMatchObject({
      sessionId: "session-deterministic",
      accountId: "acct-1",
      planId: "metered-api",
      createdAt: "2028-02-29T12:00:00.000Z",
      expiresAt: "2028-02-29T13:00:00.000Z",
      maxUnits: "10",
      usedUnits: "0",
      state: "active",
    });
  });

  it("rejects an unknown or non-metered plan", async () => {
    const service = makeService();
    await expect(service.createSession({ accountId: "acct", planId: "missing" })).rejects.toThrow("metered plan");
    await expect(service.createSession({ accountId: "acct", planId: "monthly-api" })).rejects.toThrow("metered plan");
  });

  it("calculates bigint settlement pricing exactly and ignores runtime override fields", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });

    const prepared = await service.prepareSessionSettlement({
      sessionId: "session-deterministic",
      units: 3,
      idempotencyKey: "usage-1",
      amountBaseUnits: "1",
      currency: "sol",
      recipient: platform,
      maxUnits: 999,
    } as PrepareSessionSettlementInput & Record<string, unknown>);

    expect(prepared).toMatchObject({
      operationId: "usage-1",
      sessionId: "session-deterministic",
      units: "3",
      status: "pending",
      payment: {
        amountBaseUnits: "27021597764222979",
        currency: mint,
        recipient: seller,
      },
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid settlement units: %s", async (units) => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    await expect(service.prepareSessionSettlement({ sessionId: "session-deterministic", units, idempotencyKey: "usage" })).rejects.toThrow("units");
  });

  it("requires a non-empty idempotency key", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    await expect(service.prepareSessionSettlement({ sessionId: "session-deterministic", units: 1, idempotencyKey: "" })).rejects.toThrow("idempotency");
  });

  it("returns one stable prepared operation for matching retries and rejects conflicts", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    const input = { sessionId: "session-deterministic", units: 2, idempotencyKey: "usage-1" };

    const first = await service.prepareSessionSettlement(input);
    const retry = await service.prepareSessionSettlement(input);

    expect(retry).toEqual(first);
    await expect(service.prepareSessionSettlement({ ...input, units: 3 })).rejects.toThrow("conflict");
  });

  it("atomically includes all pending reservations in capacity", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => service.prepareSessionSettlement({
        sessionId: "session-deterministic",
        units: 2,
        idempotencyKey: `usage-${index}`,
      })),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects the exact expiry boundary and closed sessions", async () => {
    let current = new Date("2028-02-29T12:00:00.000Z");
    const service = createCommerceService({
      catalog: makeCatalog(),
      store: createMemoryCommerceStore(),
      now: () => current,
      generateSessionId: () => "session-boundary",
    });
    await service.createSession({ accountId: "acct", planId: "metered-api" });

    current = new Date("2028-02-29T13:00:00.000Z");
    await expect(service.prepareSessionSettlement({ sessionId: "session-boundary", units: 1, idempotencyKey: "at-expiry" })).rejects.toThrow("expired");

    const closed = makeService({ sessionId: "session-closed" });
    await closed.createSession({ accountId: "acct", planId: "metered-api" });
    await closed.closeSession("session-closed");
    await expect(closed.prepareSessionSettlement({ sessionId: "session-closed", units: 1, idempotencyKey: "closed" })).rejects.toThrow("closed");
  });

  it("requires a receipt reference, settles once, and keeps accounting monotonic", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    await service.prepareSessionSettlement({ sessionId: "session-deterministic", units: 4, idempotencyKey: "usage-1" });

    await expect(service.completeSessionSettlement({
      sessionId: "session-deterministic",
      idempotencyKey: "usage-1",
      verifiedReceiptReference: "",
    })).rejects.toThrow("verifiedReceiptReference");

    const completed = await service.completeSessionSettlement({
      sessionId: "session-deterministic",
      idempotencyKey: "usage-1",
      verifiedReceiptReference: "receipt-1",
    });
    const retry = await service.completeSessionSettlement({
      sessionId: "session-deterministic",
      idempotencyKey: "usage-1",
      verifiedReceiptReference: "receipt-1",
    });

    expect(retry).toEqual(completed);
    expect((await service.getSession("session-deterministic"))?.usedUnits).toBe("4");
    await expect(service.completeSessionSettlement({
      sessionId: "session-deterministic",
      idempotencyKey: "usage-1",
      verifiedReceiptReference: "receipt-2",
    })).rejects.toThrow("conflict");
    expect((await service.getSession("session-deterministic"))?.usedUnits).toBe("4");
  });

  it("settles concurrent duplicate completions exactly once", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    await service.prepareSessionSettlement({ sessionId: "session-deterministic", units: 7, idempotencyKey: "usage" });

    const completions = await Promise.all(Array.from({ length: 20 }, () => service.completeSessionSettlement({
      sessionId: "session-deterministic",
      idempotencyKey: "usage",
      verifiedReceiptReference: "receipt-shared",
    })));

    expect(new Set(completions.map((result) => JSON.stringify(result))).size).toBe(1);
    expect((await service.getSession("session-deterministic"))?.usedUnits).toBe("7");
  });
});

describe("subscription renewals", () => {
  it.each([
    ["0099-12", "0099-12-01T00:00:00.000Z", "0100-01-01T00:00:00.000Z"],
    ["2028-02", "2028-02-01T00:00:00.000Z", "2028-03-01T00:00:00.000Z"],
    ["2027-02", "2027-02-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z"],
    ["2028-12", "2028-12-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z"],
  ])("uses real calendar boundaries for %s", async (period, periodStart, periodEnd) => {
    const prepared = await makeService().prepareRenewal({
      accountId: "acct",
      planId: "monthly-api",
      period,
      idempotencyKey: `renew-${period}`,
    });

    expect(prepared).toMatchObject({
      accountId: "acct",
      planId: "monthly-api",
      period,
      periodStart,
      periodEnd,
      status: "pending",
      payment: { amountBaseUnits: "12000000", recipient: seller, currency: mint },
    });
  });

  it.each(["2028-2", "2028-00", "2028-13", "28-02", "2028-02-01", "2028-02 "])("rejects malformed billing period %s", async (period) => {
    await expect(makeService().prepareRenewal({ accountId: "acct", planId: "monthly-api", period, idempotencyKey: "renew" })).rejects.toThrow("YYYY-MM");
  });

  it("keeps matching retries stable and rejects a second operation for the same period", async () => {
    const service = makeService();
    const input = { accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "renew-1" };
    const first = await service.prepareRenewal(input);
    expect(await service.prepareRenewal(input)).toEqual(first);
    await expect(service.prepareRenewal({ ...input, idempotencyKey: "renew-2" })).rejects.toThrow("conflict");
  });

  it("uses server-owned renewal terms despite runtime override fields", async () => {
    const prepared = await makeService().prepareRenewal({
      accountId: "acct",
      planId: "monthly-api",
      period: "2028-02",
      idempotencyKey: "renew",
      priceBaseUnits: "1",
      periodDurationMonths: 99,
      recipient: platform,
    } as PrepareRenewalInput & Record<string, unknown>);

    expect(prepared.payment.amountBaseUnits).toBe("12000000");
    expect(prepared.payment.recipient).toBe(seller);
    expect(prepared.periodEnd).toBe("2028-03-01T00:00:00.000Z");
  });

  it("completes once with a receipt reference and rejects conflicting completion", async () => {
    const service = makeService();
    const input = { accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "renew" };
    await service.prepareRenewal(input);
    await expect(service.completeRenewal({ ...input, verifiedReceiptReference: "" })).rejects.toThrow("verifiedReceiptReference");

    const first = await service.completeRenewal({ ...input, verifiedReceiptReference: "receipt-1" });
    expect(await service.completeRenewal({ ...input, verifiedReceiptReference: "receipt-1" })).toEqual(first);
    await expect(service.completeRenewal({ ...input, verifiedReceiptReference: "receipt-2" })).rejects.toThrow("conflict");
    await expect(service.prepareRenewal({ ...input, idempotencyKey: "renew-2" })).rejects.toThrow("active period");
  });

  it("completes concurrent duplicate renewals exactly once", async () => {
    const service = makeService();
    const input = { accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "renew" };
    await service.prepareRenewal(input);
    const results = await Promise.all(Array.from({ length: 20 }, () => service.completeRenewal({ ...input, verifiedReceiptReference: "receipt" })));
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
  });
});

describe("client input types", () => {
  it("accept only identifiers, units, and billing period", () => {
    expectTypeOf<CreateSessionInput>().toEqualTypeOf<{ accountId: string; planId: string }>();
    expectTypeOf<PrepareSessionSettlementInput>().toEqualTypeOf<{ sessionId: string; units: number; idempotencyKey: string }>();
    expectTypeOf<PrepareRenewalInput>().toEqualTypeOf<{ accountId: string; planId: string; period: string; idempotencyKey: string }>();

    if (false) {
      // @ts-expect-error price is not client-controlled
      const session: CreateSessionInput = { accountId: "acct", planId: "metered-api", maxUnits: 100 };
      // @ts-expect-error currency is not client-controlled
      const settlement: PrepareSessionSettlementInput = { sessionId: "s", units: 1, idempotencyKey: "i", currency: "sol" };
      // @ts-expect-error duration is not client-controlled
      const renewal: PrepareRenewalInput = { accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "i", periodDurationMonths: 12 };
      void [session, settlement, renewal];
    }
  });
});
