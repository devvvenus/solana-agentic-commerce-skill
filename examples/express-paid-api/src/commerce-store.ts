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
};

export type SubscriptionPeriodRecord = JsonObject & {
  kind: "subscription-period";
  subscriptionId: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  maxUnits: string;
  usedUnits: string;
};

export type CounterRecord = JsonObject & {
  value: number;
};

export type CommerceStoreItemMap = {
  [key: `counter:${string}`]: CounterRecord;
  [key: `fulfillment:${string}`]: FulfillmentRecord;
  [key: `metadata:${string}`]: JsonObject;
  [key: `session:${string}`]: MeteredSessionRecord;
  [key: `solana-charge:consumed:${string}`]: boolean;
  [key: `subscription:${string}`]: SubscriptionPeriodRecord;
};

/** Production adapters must preserve these atomic single-key update semantics. */
export interface AtomicCommerceStore<
  ItemMap extends JsonItemMap = CommerceStoreItemMap,
> {
  get<Key extends keyof ItemMap & string>(key: Key): Promise<ItemMap[Key] | null>;
  put<Key extends keyof ItemMap & string>(key: Key, value: ItemMap[Key]): Promise<void>;
  delete<Key extends keyof ItemMap & string>(key: Key): Promise<void>;
  update<Key extends keyof ItemMap & string, Result>(
    key: Key,
    fn: (current: ItemMap[Key] | null) => CommerceStoreChange<ItemMap[Key], Result>,
  ): Promise<Result>;
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
  const values = new Map<string, string>();
  const operationTails = new Map<string, Promise<void>>();

  async function withKeyLock<Result>(key: string, operation: () => Result): Promise<Result> {
    const previous = operationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    operationTails.set(key, tail);

    await previous;
    try {
      return operation();
    } finally {
      release();
      if (operationTails.get(key) === tail) operationTails.delete(key);
    }
  }

  return {
    get<Key extends keyof ItemMap & string>(key: Key) {
      return withKeyLock(key, () => {
        const stored = values.get(key);
        return stored === undefined ? null : (JSON.parse(stored) as ItemMap[Key]);
      });
    },
    put<Key extends keyof ItemMap & string>(key: Key, value: ItemMap[Key]) {
      return withKeyLock(key, () => {
        values.set(key, serializeJson(value));
      });
    },
    delete<Key extends keyof ItemMap & string>(key: Key) {
      return withKeyLock(key, () => {
        values.delete(key);
      });
    },
    update<Key extends keyof ItemMap & string, Result>(
      key: Key,
      fn: (current: ItemMap[Key] | null) => CommerceStoreChange<ItemMap[Key], Result>,
    ) {
      return withKeyLock(key, () => {
        const stored = values.get(key);
        const current = stored === undefined ? null : (JSON.parse(stored) as ItemMap[Key]);
        const change = fn(current);

        if (change.op === "set") values.set(key, serializeJson(change.value));
        if (change.op === "delete") values.delete(key);
        return change.result;
      });
    },
  };
}
