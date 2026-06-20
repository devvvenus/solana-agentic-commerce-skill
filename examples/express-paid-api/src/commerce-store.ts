import type { Store } from "mppx";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonItemMap = Record<string, JsonValue>;

export type CommerceStoreChange<Value, Result> = Store.Change<Value, Result>;

export type FulfillmentRecord = JsonObject & {
  kind: "fulfillment";
  operationId: string;
  inputHash: string;
  status: "pending" | "fulfilled" | "failed";
  expiresAt: string;
  fulfillmentId?: string;
};

export type MeteredSessionRecord = JsonObject & {
  kind: "metered-session";
  sessionId: string;
  accountId: string;
  expiresAt: string;
  maxUnits: string;
  usedUnits: string;
  planId?: string;
  createdAt?: string;
  state?: "active" | "expired" | "closed";
  reservations?: JsonObject;
  closedAt?: string;
};

export type SubscriptionPeriodRecord = JsonObject & {
  kind: "subscription-period";
  subscriptionId: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  maxUnits: string;
  usedUnits: string;
  planId?: string;
  period?: string;
  idempotencyKey?: string;
  status?: "pending" | "active";
  payment?: JsonObject;
  paymentTerms?: JsonObject;
  operationExpiresAt?: string;
  receiptReference?: string;
  verifiedAt?: string;
};

export type ReceiptClaimRecord = JsonObject & {
  kind: "receipt-claim";
  receiptReference: string;
  operationId: string;
  externalId: string;
  claimedAt: string;
};

export type CounterRecord = JsonObject & {
  value: number;
};

export type CommerceStoreItemMap = {
  [key: `counter:${string}`]: CounterRecord;
  [key: `fulfillment:${string}`]: FulfillmentRecord;
  [key: `metadata:${string}`]: JsonObject;
  [key: `receipt-claim:${string}`]: ReceiptClaimRecord;
  [key: `session:${string}`]: MeteredSessionRecord;
  [key: `solana-charge:consumed:${string}`]: boolean;
  [key: `subscription:${string}`]: SubscriptionPeriodRecord;
};

export interface CommerceStoreTransaction<ItemMap extends JsonItemMap> {
  get<Key extends keyof ItemMap & string>(key: Key): ItemMap[Key] | null;
  set<Key extends keyof ItemMap & string>(key: Key, value: ItemMap[Key]): void;
  delete<Key extends keyof ItemMap & string>(key: Key): void;
}

/**
 * Production adapters must serialize every operation with transaction() and
 * commit all transaction writes atomically or roll them all back.
 */
export interface AtomicCommerceStore<
  ItemMap extends JsonItemMap = CommerceStoreItemMap,
> {
  get<Key extends keyof ItemMap & string>(key: Key): Promise<ItemMap[Key] | null>;
  put<Key extends string>(key: Key, value: Key extends keyof ItemMap ? ItemMap[Key] : unknown): Promise<void>;
  delete(key: string): Promise<void>;
  update<Key extends keyof ItemMap & string, Result>(
    key: Key,
    fn: (current: ItemMap[Key] | null) => CommerceStoreChange<ItemMap[Key], Result>,
  ): Promise<Result>;
  /** The callback must be synchronous and side-effect free outside the transaction object. */
  transaction<Result>(fn: (transaction: CommerceStoreTransaction<ItemMap>) => Result): Promise<Result>;
}

function jsonValueError(path: string, reason: string): never {
  throw new TypeError(`Commerce store values must be JSON-safe at ${path}: ${reason}`);
}

function assertJsonSafe(value: unknown, path = "$", ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) jsonValueError(path, "numbers must be finite");
    return;
  }
  if (typeof value !== "object") jsonValueError(path, `${typeof value} is unsupported`);
  if (ancestors.has(value)) jsonValueError(path, "cyclic references are unsupported");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        jsonValueError(path, "array subclasses are unsupported");
      }
      const allowedKeys = new Set<string>(["length"]);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) jsonValueError(`${path}[${index}]`, "sparse arrays are unsupported");
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor)) {
          jsonValueError(`${path}[${index}]`, "array entries must be data properties");
        }
        allowedKeys.add(key);
        assertJsonSafe(descriptor.value, `${path}[${index}]`, ancestors);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowedKeys.has(key)) {
          jsonValueError(path, "extra array properties are unsupported");
        }
      }
      return;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      jsonValueError(path, "only plain objects and arrays are supported");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") jsonValueError(path, "symbol keys are unsupported");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        jsonValueError(`${path}.${key}`, "properties must be enumerable data properties");
      }
      assertJsonSafe(descriptor.value, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function serializeJson(value: unknown): string {
  assertJsonSafe(value);
  return JSON.stringify(value);
}

export function createMemoryCommerceStore<
  ItemMap extends JsonItemMap = CommerceStoreItemMap,
>(): AtomicCommerceStore<ItemMap> {
  let values = new Map<string, string>();
  let operationTail = Promise.resolve();

  async function withGlobalLock<Result>(operation: () => Result): Promise<Result> {
    const previous = operationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    operationTail = previous.then(() => gate);

    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  return {
    get<Key extends keyof ItemMap & string>(key: Key) {
      return withGlobalLock(() => {
        const stored = values.get(key);
        return stored === undefined ? null : (JSON.parse(stored) as ItemMap[Key]);
      });
    },
    put<Key extends string>(key: Key, value: Key extends keyof ItemMap ? ItemMap[Key] : unknown) {
      return withGlobalLock(() => {
        values.set(key, serializeJson(value));
      });
    },
    delete(key: string) {
      return withGlobalLock(() => {
        values.delete(key);
      });
    },
    update<Key extends keyof ItemMap & string, Result>(
      key: Key,
      fn: (current: ItemMap[Key] | null) => CommerceStoreChange<ItemMap[Key], Result>,
    ) {
      return withGlobalLock(() => {
        const stored = values.get(key);
        const current = stored === undefined ? null : (JSON.parse(stored) as ItemMap[Key]);
        const change = fn(current);

        if (change.op === "set") values.set(key, serializeJson(change.value));
        if (change.op === "delete") values.delete(key);
        return change.result;
      });
    },
    transaction<Result>(fn: (transaction: CommerceStoreTransaction<ItemMap>) => Result) {
      return withGlobalLock(() => {
        const staged = new Map(values);
        const transaction: CommerceStoreTransaction<ItemMap> = {
          get<Key extends keyof ItemMap & string>(key: Key) {
            const stored = staged.get(key);
            return stored === undefined ? null : (JSON.parse(stored) as ItemMap[Key]);
          },
          set<Key extends keyof ItemMap & string>(key: Key, value: ItemMap[Key]) {
            staged.set(key, serializeJson(value));
          },
          delete<Key extends keyof ItemMap & string>(key: Key) {
            staged.delete(key);
          },
        };
        const result = fn(transaction);
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          "then" in result &&
          typeof result.then === "function"
        ) {
          throw new TypeError("Commerce store transaction callbacks must be synchronous");
        }
        values = staged;
        return result;
      });
    },
  };
}
