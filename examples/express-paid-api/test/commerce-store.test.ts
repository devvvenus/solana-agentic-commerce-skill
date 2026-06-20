import { solana } from "@solana/mpp/server";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { PaymentContract } from "../src/payment-contract.js";
import {
  createMemoryCommerceStore,
  type CommerceStoreItemMap,
  type CommerceStoreTransaction,
  type CounterRecord,
  type FulfillmentRecord,
  type JsonObject,
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
    const input: JsonObject = { nested: { count: 1 }, tags: ["paid"] };

    await store.put("metadata:record", input);
    (input.nested as JsonObject).count = 2;
    const firstRead = await store.get("metadata:record");
    if (!Array.isArray(firstRead!.tags)) throw new Error("Expected tags array");
    firstRead!.tags.push({ state: "mutated" });

    expect(firstRead).toEqual({ nested: { count: 1 }, tags: ["paid", { state: "mutated" }] });
    expect(await store.get("metadata:record")).toEqual({
      nested: { count: 1 },
      tags: ["paid"],
    });
  });

  it("deletes stored values", async () => {
    const store = createMemoryCommerceStore();
    await store.put("counter:record", { value: 1 });

    await store.delete("counter:record");

    expect(await store.get("counter:record")).toBeNull();
  });

  it("atomically deletes a value and returns the caller result", async () => {
    const store = createMemoryCommerceStore();
    await store.put("counter:record", { value: 1 });

    const result = await store.update("counter:record", () => ({
      op: "delete",
      result: "deleted" as const,
    }));

    expect(result).toBe("deleted");
    expect(await store.get("counter:record")).toBeNull();
  });

  it("binds key patterns to their record value types", async () => {
    const store = createMemoryCommerceStore();
    const fulfillment = await store.get("fulfillment:typed");
    const session = await store.get("session:typed");
    const subscription = await store.get("subscription:typed");
    const counter = await store.get("counter:typed");

    expectTypeOf(fulfillment).toEqualTypeOf<FulfillmentRecord | null>();
    expectTypeOf(session).toEqualTypeOf<MeteredSessionRecord | null>();
    expectTypeOf(subscription).toEqualTypeOf<SubscriptionPeriodRecord | null>();
    expectTypeOf(counter).toEqualTypeOf<CounterRecord | null>();

    if (false) {
      // @ts-expect-error a session key cannot store a fulfillment record
      await store.put("session:wrong", {} as FulfillmentRecord);
      // @ts-expect-error commerce keys must use a declared key pattern
      await store.get("unknown:typed");
      await store.update("counter:wrong", () => ({
        op: "set",
        // @ts-expect-error an atomic counter update cannot set a fulfillment record
        value: {} as FulfillmentRecord,
        result: true,
      }));
      // @ts-expect-error atomic update callbacks must return synchronously
      await store.update("counter:async", async () => ({ op: "noop", result: true }));
    }
  });

  it.each([
    ["top-level undefined", undefined],
    ["nested undefined", { nested: undefined }],
    ["function", () => true],
    ["symbol", Symbol("unsupported")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["Date", new Date("2026-06-21T00:00:00.000Z")],
    ["Map", new Map([["value", 1]])],
    ["Set", new Set([1])],
    ["custom prototype", new (class UnsupportedValue { value = 1; })()],
  ])("rejects unsupported JSON value: %s", async (_label, value) => {
    const store = createMemoryCommerceStore();

    await expect(store.put("metadata:invalid", value as never)).rejects.toThrow("JSON-safe");
  });

  it("rejects cyclic objects", async () => {
    const store = createMemoryCommerceStore();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(store.put("metadata:cyclic", cyclic as never)).rejects.toThrow("JSON-safe");
  });

  it("rejects array properties that JSON serialization would drop", async () => {
    const store = createMemoryCommerceStore();
    const array = [1] as number[] & { extra?: number };
    array.extra = 2;

    await expect(store.put("metadata:array", { array } as never)).rejects.toThrow("JSON-safe");
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
      store.update("fulfillment:operation-1", (current) =>
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
    await store.put(key, {
      kind: "fulfillment",
      operationId: "operation-1",
      inputHash: "sha256:original",
      status: "fulfilled",
      expiresAt: "2026-06-20T12:00:00.000Z",
      fulfillmentId: "delivery-1",
    });

    const classify = (inputHash: string) =>
      store.update(key, (current) => ({
        op: "noop",
        result: current?.inputHash === inputHash ? "retry" : "conflict",
      }));

    expect(await classify("sha256:original")).toBe("retry");
    expect(await classify("sha256:different")).toBe("conflict");
  });

  it("serializes concurrent updates on the same key without losing writes", async () => {
    const store = createMemoryCommerceStore();
    await store.put("counter:concurrent", { value: 0 });

    await Promise.all(
      Array.from({ length: 200 }, () =>
        store.update("counter:concurrent", (current) => ({
          op: "set",
          value: { value: (current?.value ?? 0) + 1 },
          result: undefined,
        })),
      ),
    );

    expect(await store.get("counter:concurrent")).toEqual({ value: 200 });
  });

  it("releases a same-key queue after an update callback throws", async () => {
    const store = createMemoryCommerceStore();
    await store.put("counter:failure", { value: 0 });

    const failed = store
      .update("counter:failure", () => {
        throw new Error("update failed");
      })
      .then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
    const queued = store.update("counter:failure", (current) => ({
      op: "set",
      value: { value: current!.value + 1 },
      result: 1,
    }));
    const later = store.update("counter:failure", (current) => ({
      op: "set",
      value: { value: current!.value + 1 },
      result: 2,
    }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("same-key update queue timed out")), 500);
    });

    try {
      await expect(Promise.race([Promise.all([failed, queued, later]), bounded])).resolves.toEqual([
        "update failed",
        1,
        2,
      ]);
    } finally {
      clearTimeout(timeout);
    }
    expect(await store.get("counter:failure")).toEqual({ value: 2 });
  });

  it("rolls back every key when a multi-key transaction throws", async () => {
    const store = createMemoryCommerceStore();
    await store.put("counter:first", { value: 1 });
    await store.put("counter:second", { value: 2 });

    await expect(store.transaction((transaction) => {
      transaction.set("counter:first", { value: 10 });
      transaction.delete("counter:second");
      throw new Error("transaction failed");
    })).rejects.toThrow("transaction failed");

    expect(await store.get("counter:first")).toEqual({ value: 1 });
    expect(await store.get("counter:second")).toEqual({ value: 2 });
  });

  it("serializes multi-key transactions against regular operations", async () => {
    const store = createMemoryCommerceStore();
    await store.put("counter:first", { value: 0 });
    await store.put("counter:second", { value: 0 });

    await Promise.all(Array.from({ length: 100 }, () => store.transaction((transaction) => {
      const first = transaction.get("counter:first")!;
      const second = transaction.get("counter:second")!;
      transaction.set("counter:first", { value: first.value + 1 });
      transaction.set("counter:second", { value: second.value + 1 });
    })));

    expect(await store.get("counter:first")).toEqual({ value: 100 });
    expect(await store.get("counter:second")).toEqual({ value: 100 });
  });

  it("rejects Promise-returning transaction callbacks without committing writes", async () => {
    const store = createMemoryCommerceStore();
    await store.put("counter:first", { value: 1 });

    await expect(store.transaction((async (transaction: CommerceStoreTransaction<CommerceStoreItemMap>) => {
      transaction.set("counter:first", { value: 2 });
      return "invalid";
    }) as never)).rejects.toThrow("synchronous");

    expect(await store.get("counter:first")).toEqual({ value: 1 });
  });

  it("round-trips fulfillment, metered session, and subscription period records", async () => {
    const store = createMemoryCommerceStore();
    const records = {
      "fulfillment:roundtrip": {
        kind: "fulfillment",
        operationId: "operation-2",
        inputHash: "sha256:two",
        status: "fulfilled",
        expiresAt: "2026-06-21T12:00:00.000Z",
        fulfillmentId: "delivery-2",
      } satisfies FulfillmentRecord,
      "session:roundtrip": {
        kind: "metered-session",
        sessionId: "session-1",
        accountId: "account-1",
        expiresAt: "2026-06-21T12:00:00.000Z",
        maxUnits: "900719925474099312345",
        usedUnits: "17",
      } satisfies MeteredSessionRecord,
      "subscription:roundtrip": {
        kind: "subscription-period",
        subscriptionId: "subscription-1",
        accountId: "account-1",
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-07-01T00:00:00.000Z",
        maxUnits: "18446744073709551615",
        usedUnits: "42",
      } satisfies SubscriptionPeriodRecord,
    };

    await Promise.all([
      store.put("fulfillment:roundtrip", records["fulfillment:roundtrip"]),
      store.put("session:roundtrip", records["session:roundtrip"]),
      store.put("subscription:roundtrip", records["subscription:roundtrip"]),
    ]);

    await expect(store.get("fulfillment:roundtrip")).resolves.toEqual(
      records["fulfillment:roundtrip"],
    );
    await expect(store.get("session:roundtrip")).resolves.toEqual(records["session:roundtrip"]);
    await expect(store.get("subscription:roundtrip")).resolves.toEqual(
      records["subscription:roundtrip"],
    );
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
