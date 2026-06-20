import { solana } from "@solana/mpp/server";
import { describe, expect, it, vi } from "vitest";

import type { PaymentContract } from "../src/payment-contract.js";
import {
  createMemoryCommerceStore,
  type FulfillmentRecord,
  type MeteredSessionRecord,
  type SubscriptionPeriodRecord,
} from "../src/commerce-store.js";
import { createPaymentMiddleware, sharedReplayStore } from "../src/payments.js";

const chargeSpy = vi.spyOn(solana, "charge");

const contract: PaymentContract = {
  amountBaseUnits: "1000",
  currency: "sol",
  description: "Paid agentic commerce endpoint",
  recipient: "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
  network: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
  secretKey: "unit-test-secret-with-sufficient-entropy",
  realm: "Test Realm",
};

describe("createMemoryCommerceStore", () => {
  it("isolates values across the JSON put/get boundary", async () => {
    const store = createMemoryCommerceStore();
    const input = { nested: { count: 1 }, tags: ["paid"] };

    await store.put("record", input);
    input.nested.count = 2;
    const firstRead = await store.get<typeof input>("record");
    firstRead!.tags.push("mutated");

    expect(firstRead).toEqual({ nested: { count: 1 }, tags: ["paid", "mutated"] });
    expect(await store.get("record")).toEqual({ nested: { count: 1 }, tags: ["paid"] });
  });

  it("deletes stored values", async () => {
    const store = createMemoryCommerceStore();
    await store.put("record", { value: true });

    await store.delete("record");

    expect(await store.get("record")).toBeNull();
  });

  it("atomically deletes a value and returns the caller result", async () => {
    const store = createMemoryCommerceStore();
    await store.put("record", { value: true });

    const result = await store.update("record", () => ({
      op: "delete",
      result: "deleted" as const,
    }));

    expect(result).toBe("deleted");
    expect(await store.get("record")).toBeNull();
  });

  it("atomically creates an idempotency record once", async () => {
    const store = createMemoryCommerceStore();
    const record: FulfillmentRecord = {
      kind: "fulfillment",
      operationId: "operation-1",
      inputHash: "sha256:one",
      status: "pending",
      expiresAt: "2026-06-20T12:00:00.000Z",
    };

    const create = () =>
      store.update<FulfillmentRecord, "created" | "existing">("fulfillment:operation-1", (current) =>
        current === null
          ? { op: "set", value: record, result: "created" }
          : { op: "noop", result: "existing" },
      );

    expect(await Promise.all([create(), create()])).toEqual(["created", "existing"]);
    expect(await store.get("fulfillment:operation-1")).toEqual(record);
  });

  it("distinguishes a conflicting operation input from an idempotent retry", async () => {
    const store = createMemoryCommerceStore();
    const key = "fulfillment:operation-1";
    await store.put<FulfillmentRecord>(key, {
      kind: "fulfillment",
      operationId: "operation-1",
      inputHash: "sha256:original",
      status: "fulfilled",
      expiresAt: "2026-06-20T12:00:00.000Z",
      fulfillmentId: "delivery-1",
    });

    const classify = (inputHash: string) =>
      store.update<FulfillmentRecord, "retry" | "conflict">(key, (current) => ({
        op: "noop",
        result: current?.inputHash === inputHash ? "retry" : "conflict",
      }));

    expect(await classify("sha256:original")).toBe("retry");
    expect(await classify("sha256:different")).toBe("conflict");
  });

  it("serializes concurrent updates on the same key without losing writes", async () => {
    const store = createMemoryCommerceStore();
    await store.put("counter", { value: 0 });

    await Promise.all(
      Array.from({ length: 200 }, () =>
        store.update<{ value: number }, void>("counter", (current) => ({
          op: "set",
          value: { value: (current?.value ?? 0) + 1 },
          result: undefined,
        })),
      ),
    );

    expect(await store.get("counter")).toEqual({ value: 200 });
  });

  it("round-trips fulfillment, metered session, and subscription period records", async () => {
    const store = createMemoryCommerceStore();
    const records = {
      fulfillment: {
        kind: "fulfillment",
        operationId: "operation-2",
        inputHash: "sha256:two",
        status: "fulfilled",
        expiresAt: "2026-06-21T12:00:00.000Z",
        fulfillmentId: "delivery-2",
      } satisfies FulfillmentRecord,
      session: {
        kind: "metered-session",
        sessionId: "session-1",
        accountId: "account-1",
        expiresAt: "2026-06-21T12:00:00.000Z",
        maxUnits: "900719925474099312345",
        usedUnits: "17",
      } satisfies MeteredSessionRecord,
      subscription: {
        kind: "subscription-period",
        subscriptionId: "subscription-1",
        accountId: "account-1",
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-07-01T00:00:00.000Z",
        maxUnits: "18446744073709551615",
        usedUnits: "42",
      } satisfies SubscriptionPeriodRecord,
    };

    await Promise.all(Object.entries(records).map(([key, value]) => store.put(key, value)));

    await expect(store.get("fulfillment")).resolves.toEqual(records.fulfillment);
    await expect(store.get("session")).resolves.toEqual(records.session);
    await expect(store.get("subscription")).resolves.toEqual(records.subscription);
  });
});

describe("createPaymentMiddleware", () => {
  it("passes an injected replay store and the original splits to the Solana SDK", () => {
    const store = createMemoryCommerceStore();
    const splits = [
      {
        recipient: "BPFLoaderUpgradeab1e11111111111111111111111",
        amount: "250",
      },
    ];
    const splitContract: PaymentContract = { ...contract, splits };

    createPaymentMiddleware(splitContract, store);

    expect(chargeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        store,
        splits,
      }),
    );
  });

  it("reuses one shared replay store when called without an explicit store", () => {
    const firstContract = { ...contract, rpcUrl: "https://rpc.example/first" };
    const secondContract = { ...contract, rpcUrl: "https://rpc.example/second" };

    createPaymentMiddleware(firstContract);
    createPaymentMiddleware(secondContract);

    expect(chargeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcUrl: firstContract.rpcUrl,
        store: sharedReplayStore,
      }),
    );
    expect(chargeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcUrl: secondContract.rpcUrl,
        store: sharedReplayStore,
      }),
    );
  });
});
