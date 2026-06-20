import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CommerceError,
  paymentTermsSplitDigest,
  readCommerceCatalog,
  type CommerceCatalog,
  type PaymentTerms,
} from "../src/catalog.js";
import {
  createCommerceService,
  createVerifiedPaymentFromVerification,
  type CreateSessionInput,
  type PrepareRenewalInput,
  type PrepareSessionSettlementInput,
  type PreparedRenewal,
  type PreparedSessionSettlement,
  type VerifiedPayment,
} from "../src/commerce-service.js";
import {
  createMemoryCommerceStore,
  type AtomicCommerceStore,
} from "../src/commerce-store.js";

const seller = "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY";
const platform = "BPFLoaderUpgradeab1e11111111111111111111111";
const referrer = "Vote111111111111111111111111111111111111111";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const privateSecret = "unit-test-secret-with-sufficient-entropy";
const MAX_U64 = 18446744073709551615n;

function catalogJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    payment: {
      currency: mint,
      decimals: 6,
      network: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      secretKey: privateSecret,
      realm: "Private Commerce Realm",
    },
    premiumProducts: [{
      id: "premium-report",
      amountBaseUnits: "2500000",
      description: "Premium research report",
      recipient: seller,
    }],
    marketplaceProducts: [{
      id: "marketplace-dataset",
      amountBaseUnits: "10000000",
      description: "Marketplace dataset",
      recipient: seller,
      splits: [
        { recipient: platform, amount: "1000000", memo: "Platform" },
        { recipient: referrer, amount: "500000", memo: "Referrer" },
      ],
    }],
    meteredPlans: [{
      id: "metered-api",
      unitPriceBaseUnits: "9007199254740993",
      maxUnits: 10,
      sessionTtlSeconds: 3600,
      paymentExpirySeconds: 60,
      description: "Metered API usage",
      recipient: seller,
    }],
    subscriptionPlans: [{
      id: "monthly-api",
      priceBaseUnits: "12000000",
      periodDurationMonths: 1,
      paymentExpirySeconds: 300,
      description: "Monthly API access",
      recipient: seller,
    }],
    ...overrides,
  });
}

function makeCatalog(overrides: Record<string, unknown> = {}): CommerceCatalog {
  return readCommerceCatalog({ COMMERCE_CATALOG_JSON: catalogJson(overrides) });
}

function clock(start = "2028-02-29T12:00:00.000Z") {
  let value = new Date(start);
  return {
    now: () => new Date(value),
    set: (next: string) => { value = new Date(next); },
  };
}

function makeService(options: {
  catalog?: CommerceCatalog;
  store?: AtomicCommerceStore;
  currentTime?: ReturnType<typeof clock>;
  sessionIds?: string[];
} = {}) {
  const ids = [...(options.sessionIds ?? ["session-1"])];
  return createCommerceService({
    catalog: options.catalog ?? makeCatalog(),
    store: options.store ?? createMemoryCommerceStore(),
    now: options.currentTime?.now ?? (() => new Date("2028-02-29T12:00:00.000Z")),
    generateSessionId: () => ids.shift() ?? "session-fallback",
  });
}

function verifiedFor(
  prepared: PreparedSessionSettlement | PreparedRenewal,
  overrides: Partial<{
    operationId: string;
    externalId: string;
    receiptReference: string;
    verifiedAt: string;
    amountBaseUnits: string;
    currency: string;
    recipient: string;
    splitDigest: string;
  }> = {},
): VerifiedPayment {
  return createVerifiedPaymentFromVerification({
    operationId: prepared.operationId,
    externalId: prepared.paymentTerms.externalId,
    receiptReference: "receipt-1",
    verifiedAt: "2028-02-29T12:00:30.000Z",
    amountBaseUnits: prepared.paymentTerms.amountBaseUnits,
    currency: prepared.paymentTerms.currency,
    recipient: prepared.paymentTerms.recipient,
    splitDigest: paymentTermsSplitDigest(prepared.paymentTerms),
    ...overrides,
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: CommerceError["code"],
): Promise<CommerceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CommerceError);
    expect((error as CommerceError).code).toBe(code);
    return error as CommerceError;
  }
  throw new Error(`Expected CommerceError code ${code}`);
}

function recursivelyContains(value: unknown, needle: string): boolean {
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((item) => recursivelyContains(item, needle));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) => key === needle || recursivelyContains(item, needle),
    );
  }
  return false;
}

describe("server-owned catalog and public payment terms", () => {
  it("contains every commerce category without exposing private MPP configuration", () => {
    const catalog = makeCatalog();
    const entries = [
      ...catalog.premiumProducts.values(),
      ...catalog.marketplaceProducts.values(),
      ...catalog.meteredPlans.values(),
      ...catalog.subscriptionPlans.values(),
    ];

    expect(entries).toHaveLength(4);
    expect(recursivelyContains(entries, "secretKey")).toBe(false);
    expect(recursivelyContains(entries, privateSecret)).toBe(false);
    expect(recursivelyContains(entries, "realm")).toBe(false);
    expect(recursivelyContains(entries, "Private Commerce Realm")).toBe(false);
    expect(catalog.marketplaceProducts.get("marketplace-dataset")?.paymentTerms.splits).toHaveLength(2);
  });

  it("exposes only the public PaymentTerms shape", () => {
    const terms = makeCatalog().premiumProducts.get("premium-report")!.paymentTerms;
    expect(terms).toEqual({
      amountBaseUnits: "2500000",
      currency: mint,
      decimals: 6,
      description: "Premium research report",
      recipient: seller,
    });
    expectTypeOf(terms).toEqualTypeOf<PaymentTerms>();
  });

  it.each([
    ["charge above u64", { premiumProducts: [{ id: "bad", amountBaseUnits: (MAX_U64 + 1n).toString(), description: "Bad", recipient: seller }] }],
    ["unit price above u64", { meteredPlans: [{ id: "bad", unitPriceBaseUnits: (MAX_U64 + 1n).toString(), maxUnits: 1, sessionTtlSeconds: 60, paymentExpirySeconds: 30, description: "Bad", recipient: seller }] }],
    ["split above u64", { marketplaceProducts: [{ id: "bad", amountBaseUnits: MAX_U64.toString(), description: "Bad", recipient: seller, splits: [{ recipient: platform, amount: (MAX_U64 + 1n).toString() }] }] }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => makeCatalog(overrides)).toThrowError(expect.objectContaining({ code: "VALIDATION" }));
  });

  it("accepts the maximum u64 charge", () => {
    const catalog = makeCatalog({
      premiumProducts: [{ id: "max", amountBaseUnits: MAX_U64.toString(), description: "Max", recipient: seller }],
    });
    expect(catalog.premiumProducts.get("max")?.paymentTerms.amountBaseUnits).toBe(MAX_U64.toString());
  });

  it("retains strict YYYY-MM calendar boundaries including leap years and years below 100", async () => {
    const service = makeService();
    const early = await service.prepareRenewal({ accountId: "acct", planId: "monthly-api", period: "0099-12", idempotencyKey: "early" });
    const leap = await service.prepareRenewal({ accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "leap" });
    expect([early.periodStart, early.periodEnd]).toEqual(["0099-12-01T00:00:00.000Z", "0100-01-01T00:00:00.000Z"]);
    expect([leap.periodStart, leap.periodEnd]).toEqual(["2028-02-01T00:00:00.000Z", "2028-03-01T00:00:00.000Z"]);
    await expectCode(service.prepareRenewal({ accountId: "acct", planId: "monthly-api", period: "2028-2", idempotencyKey: "bad" }), "VALIDATION");
  });
});

describe("metered reservation lifecycle", () => {
  it("prepares durable public terms with exact bigint pricing and no private configuration", async () => {
    const store = createMemoryCommerceStore();
    const service = makeService({ store });
    await service.createSession({ accountId: "acct", planId: "metered-api" });

    const prepared = await service.prepareSessionSettlement({ sessionId: "session-1", units: 3, idempotencyKey: "usage-1" });
    const persisted = await store.get("session:session-1");

    expect(prepared).toMatchObject({
      operationId: "usage-1",
      externalId: "session:session-1:settlement:usage-1",
      units: "3",
      status: "pending",
      reservationExpiresAt: "2028-02-29T12:01:00.000Z",
      paymentTerms: {
        amountBaseUnits: "27021597764222979",
        currency: mint,
        recipient: seller,
        expiresAt: "2028-02-29T12:01:00.000Z",
      },
    });
    expect(recursivelyContains(prepared, "secretKey")).toBe(false);
    expect(recursivelyContains(prepared, privateSecret)).toBe(false);
    expect(recursivelyContains(persisted, "secretKey")).toBe(false);
    expect(recursivelyContains(persisted, privateSecret)).toBe(false);
  });

  it("rejects checked multiplication overflow but accepts exactly MAX_U64", async () => {
    const basePlan = {
      id: "metered-api",
      maxUnits: 10,
      sessionTtlSeconds: 3600,
      paymentExpirySeconds: 60,
      description: "Metered",
      recipient: seller,
    };
    const exact = makeService({ catalog: makeCatalog({ meteredPlans: [{ ...basePlan, unitPriceBaseUnits: MAX_U64.toString() }] }) });
    await exact.createSession({ accountId: "acct", planId: "metered-api" });
    expect((await exact.prepareSessionSettlement({ sessionId: "session-1", units: 1, idempotencyKey: "max" })).paymentTerms.amountBaseUnits).toBe(MAX_U64.toString());

    const overflow = makeService({ catalog: makeCatalog({ meteredPlans: [{ ...basePlan, unitPriceBaseUnits: (MAX_U64 / 2n + 1n).toString() }] }) });
    await overflow.createSession({ accountId: "acct", planId: "metered-api" });
    await expectCode(overflow.prepareSessionSettlement({ sessionId: "session-1", units: 2, idempotencyKey: "overflow" }), "VALIDATION");
  });

  it("atomically releases expired reservations before calculating capacity", async () => {
    const currentTime = clock();
    const service = makeService({ currentTime });
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    await service.prepareSessionSettlement({ sessionId: "session-1", units: 10, idempotencyKey: "old" });

    currentTime.set("2028-02-29T12:01:00.001Z");
    const replacement = await service.prepareSessionSettlement({ sessionId: "session-1", units: 10, idempotencyKey: "new" });

    expect(replacement.status).toBe("pending");
    await expectCode(service.prepareSessionSettlement({ sessionId: "session-1", units: 10, idempotencyKey: "old" }), "EXPIRED");
  });

  it("cancels a pending reservation without incrementing usage and releases capacity", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    await service.prepareSessionSettlement({ sessionId: "session-1", units: 10, idempotencyKey: "cancelled" });

    const cancelled = await service.cancelSessionSettlement({ sessionId: "session-1", idempotencyKey: "cancelled" });
    const replacement = await service.prepareSessionSettlement({ sessionId: "session-1", units: 10, idempotencyKey: "replacement" });

    expect(cancelled.status).toBe("cancelled");
    expect(replacement.status).toBe("pending");
    expect((await service.getSession("session-1"))?.usedUnits).toBe("0");
  });

  it("returns one durable reservation for concurrent matching idempotent preparations", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    const input = { sessionId: "session-1", units: 4, idempotencyKey: "same" };

    const results = await Promise.all(Array.from({ length: 20 }, () => service.prepareSessionSettlement(input)));

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    await service.prepareSessionSettlement({ sessionId: "session-1", units: 6, idempotencyKey: "remaining" });
    await expectCode(service.prepareSessionSettlement({ sessionId: "session-1", units: 1, idempotencyKey: "over" }), "CAPACITY_EXCEEDED");
  });

  it("uses stable CommerceError codes for lifecycle and state failures", async () => {
    const service = makeService();
    await expectCode(service.createSession({ accountId: "acct", planId: "missing" }), "NOT_FOUND");
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    await expectCode(service.prepareSessionSettlement({ sessionId: "session-1", units: 0, idempotencyKey: "bad" }), "VALIDATION");
    await service.prepareSessionSettlement({ sessionId: "session-1", units: 10, idempotencyKey: "full" });
    await expectCode(service.prepareSessionSettlement({ sessionId: "session-1", units: 1, idempotencyKey: "extra" }), "CAPACITY_EXCEEDED");
    await expectCode(service.prepareSessionSettlement({ sessionId: "session-1", units: 9, idempotencyKey: "full" }), "CONFLICT");
    await service.closeSession("session-1");
    await expectCode(service.prepareSessionSettlement({ sessionId: "session-1", units: 1, idempotencyKey: "closed" }), "CLOSED");
  });

  it("rejects a corrupt persisted session with CORRUPT_STATE", async () => {
    const store = createMemoryCommerceStore();
    await store.put("session:broken", {
      kind: "metered-session",
      sessionId: "broken",
      accountId: "acct",
      planId: "metered-api",
      createdAt: "2028-02-29T12:00:00.000Z",
      expiresAt: "2028-02-29T13:00:00.000Z",
      maxUnits: "10",
      usedUnits: "not-decimal",
      state: "active",
      reservations: {},
    });
    await expectCode(makeService({ store }).prepareSessionSettlement({ sessionId: "broken", units: 1, idempotencyKey: "x" }), "CORRUPT_STATE");
  });
});

describe("verified payment completion and receipt claims", () => {
  it("requires the branded verification boundary at compile time", () => {
    expectTypeOf(createVerifiedPaymentFromVerification).returns.toMatchTypeOf<VerifiedPayment>();
    if (false) {
      // @ts-expect-error raw request data is not a VerifiedPayment
      const raw: VerifiedPayment = { receiptReference: "receipt" };
      void raw;
    }
  });

  it("rejects a runtime object that bypasses the verification constructor", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    const prepared = await service.prepareSessionSettlement({ sessionId: "session-1", units: 1, idempotencyKey: "usage" });
    const rawClone = { ...verifiedFor(prepared) } as VerifiedPayment;

    await expectCode(service.completeSessionSettlement({
      sessionId: "session-1",
      idempotencyKey: "usage",
      verifiedPayment: rawClone,
    }), "VALIDATION");
  });

  it.each([
    ["operation", { operationId: "other" }],
    ["external id", { externalId: "other" }],
    ["amount", { amountBaseUnits: "1" }],
    ["currency", { currency: "sol" }],
    ["recipient", { recipient: platform }],
    ["splits", { splitDigest: "sha256:different" }],
  ])("rejects verified payment %s mismatch", async (_label, override) => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    const prepared = await service.prepareSessionSettlement({ sessionId: "session-1", units: 1, idempotencyKey: "usage" });
    await expectCode(service.completeSessionSettlement({ sessionId: "session-1", idempotencyKey: "usage", verifiedPayment: verifiedFor(prepared, override) }), "RECEIPT_MISMATCH");
  });

  it("recovers across service restart and completes the same operation exactly once", async () => {
    const store = createMemoryCommerceStore();
    const firstProcess = makeService({ store });
    await firstProcess.createSession({ accountId: "acct", planId: "metered-api" });
    const prepared = await firstProcess.prepareSessionSettlement({ sessionId: "session-1", units: 4, idempotencyKey: "usage" });
    const verifiedPayment = verifiedFor(prepared);

    const restartedProcess = makeService({ store });
    const completed = await restartedProcess.completeSessionSettlement({ sessionId: "session-1", idempotencyKey: "usage", verifiedPayment });
    const retry = await restartedProcess.completeSessionSettlement({ sessionId: "session-1", idempotencyKey: "usage", verifiedPayment });

    expect(retry).toEqual(completed);
    expect((await restartedProcess.getSession("session-1"))?.usedUnits).toBe("4");
    expect(await store.get("receipt-claim:receipt-1")).toMatchObject({ externalId: prepared.externalId });
  });

  it("serializes concurrent duplicate completion without a second usage increment", async () => {
    const service = makeService();
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    const prepared = await service.prepareSessionSettlement({ sessionId: "session-1", units: 7, idempotencyKey: "usage" });
    const verifiedPayment = verifiedFor(prepared);

    const results = await Promise.all(Array.from({ length: 20 }, () => service.completeSessionSettlement({
      sessionId: "session-1",
      idempotencyKey: "usage",
      verifiedPayment,
    })));

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect((await service.getSession("session-1"))?.usedUnits).toBe("7");
  });

  it("allows post-expiry recovery only when verification occurred by reservation expiry", async () => {
    const currentTime = clock();
    const service = makeService({ currentTime });
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    const prepared = await service.prepareSessionSettlement({ sessionId: "session-1", units: 2, idempotencyKey: "usage" });
    currentTime.set("2028-02-29T13:00:00.000Z");

    const completed = await service.completeSessionSettlement({
      sessionId: "session-1",
      idempotencyKey: "usage",
      verifiedPayment: verifiedFor(prepared, { verifiedAt: "2028-02-29T12:00:59.999Z" }),
    });
    expect(completed.status).toBe("settled");

    const secondStore = createMemoryCommerceStore();
    const secondClock = clock();
    const second = makeService({ store: secondStore, currentTime: secondClock });
    await second.createSession({ accountId: "acct", planId: "metered-api" });
    const late = await second.prepareSessionSettlement({ sessionId: "session-1", units: 2, idempotencyKey: "late" });
    secondClock.set("2028-02-29T13:00:00.000Z");
    await expectCode(second.completeSessionSettlement({ sessionId: "session-1", idempotencyKey: "late", verifiedPayment: verifiedFor(late, { receiptReference: "late-receipt", verifiedAt: "2028-02-29T12:01:00.001Z" }) }), "EXPIRED");
  });

  it("allows a pre-closure verified payment and rejects one verified after closure", async () => {
    const currentTime = clock();
    const service = makeService({ currentTime });
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    const first = await service.prepareSessionSettlement({ sessionId: "session-1", units: 1, idempotencyKey: "before" });
    const second = await service.prepareSessionSettlement({ sessionId: "session-1", units: 1, idempotencyKey: "after" });
    currentTime.set("2028-02-29T12:00:40.000Z");
    await service.closeSession("session-1");

    expect((await service.completeSessionSettlement({ sessionId: "session-1", idempotencyKey: "before", verifiedPayment: verifiedFor(first, { verifiedAt: "2028-02-29T12:00:30.000Z" }) })).status).toBe("settled");
    await expectCode(service.completeSessionSettlement({ sessionId: "session-1", idempotencyKey: "after", verifiedPayment: verifiedFor(second, { receiptReference: "receipt-2", verifiedAt: "2028-02-29T12:00:41.000Z" }) }), "CLOSED");
  });

  it("atomically prevents one receipt from completing different resources concurrently", async () => {
    const store = createMemoryCommerceStore();
    const service = makeService({ store, sessionIds: ["session-a", "session-b"] });
    await service.createSession({ accountId: "acct-a", planId: "metered-api" });
    await service.createSession({ accountId: "acct-b", planId: "metered-api" });
    const first = await service.prepareSessionSettlement({ sessionId: "session-a", units: 2, idempotencyKey: "usage" });
    const second = await service.prepareSessionSettlement({ sessionId: "session-b", units: 3, idempotencyKey: "usage" });

    const results = await Promise.allSettled([
      service.completeSessionSettlement({ sessionId: "session-a", idempotencyKey: "usage", verifiedPayment: verifiedFor(first, { receiptReference: "shared" }) }),
      service.completeSessionSettlement({ sessionId: "session-b", idempotencyKey: "usage", verifiedPayment: verifiedFor(second, { receiptReference: "shared" }) }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "RECEIPT_ALREADY_CLAIMED" });
    const totalUsed = BigInt((await service.getSession("session-a"))!.usedUnits) + BigInt((await service.getSession("session-b"))!.usedUnits);
    expect([2n, 3n]).toContain(totalUsed);
  });
});

describe("subscription recovery", () => {
  it("persists public terms, completes after restart, and globally claims the receipt", async () => {
    const store = createMemoryCommerceStore();
    const prepared = await makeService({ store }).prepareRenewal({ accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "renew" });
    const persisted = await store.get("subscription:acct:monthly-api:2028-02");
    expect(recursivelyContains(prepared, privateSecret)).toBe(false);
    expect(recursivelyContains(persisted, privateSecret)).toBe(false);
    expect(recursivelyContains(persisted, "secretKey")).toBe(false);

    const restarted = makeService({ store });
    const payment = verifiedFor(prepared, { receiptReference: "renewal-receipt" });
    const completed = await restarted.completeRenewal({ accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "renew", verifiedPayment: payment });
    expect(await restarted.completeRenewal({ accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "renew", verifiedPayment: payment })).toEqual(completed);
    expect(await store.get("receipt-claim:renewal-receipt")).toMatchObject({ externalId: prepared.externalId });
    expect(await store.get("subscription:acct:monthly-api:2028-02")).toMatchObject({ receiptReference: "renewal-receipt" });
    expect(recursivelyContains(await store.get("subscription:acct:monthly-api:2028-02"), "verifiedReceiptReference")).toBe(false);
  });

  it("rejects a receipt already claimed by a metered settlement", async () => {
    const store = createMemoryCommerceStore();
    const service = makeService({ store });
    await service.createSession({ accountId: "acct", planId: "metered-api" });
    const settlement = await service.prepareSessionSettlement({ sessionId: "session-1", units: 1, idempotencyKey: "usage" });
    await service.completeSessionSettlement({ sessionId: "session-1", idempotencyKey: "usage", verifiedPayment: verifiedFor(settlement, { receiptReference: "shared" }) });
    const renewal = await service.prepareRenewal({ accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "renew" });
    await expectCode(service.completeRenewal({ accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "renew", verifiedPayment: verifiedFor(renewal, { receiptReference: "shared" }) }), "RECEIPT_ALREADY_CLAIMED");
  });
});

describe("client input types", () => {
  it("accept only identifiers, units, period, and branded verification evidence", () => {
    expectTypeOf<CreateSessionInput>().toEqualTypeOf<{ accountId: string; planId: string }>();
    expectTypeOf<PrepareSessionSettlementInput>().toEqualTypeOf<{ sessionId: string; units: number; idempotencyKey: string }>();
    expectTypeOf<PrepareRenewalInput>().toEqualTypeOf<{ accountId: string; planId: string; period: string; idempotencyKey: string }>();
  });
});
