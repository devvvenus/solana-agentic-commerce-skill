import type { Store } from "mppx";

export type CommerceStoreChange<Value, Result> = Store.Change<Value, Result>;

/** Production adapters must preserve these atomic single-key update semantics. */
export interface AtomicCommerceStore {
  get<Value = unknown>(key: string): Promise<Value | null>;
  put<Value>(key: string, value: Value): Promise<void>;
  delete(key: string): Promise<void>;
  update<Value = unknown, Result = void>(
    key: string,
    fn: (current: Value | null) => CommerceStoreChange<Value, Result>,
  ): Promise<Result>;
}

export interface FulfillmentRecord {
  kind: "fulfillment";
  operationId: string;
  inputHash: string;
  status: "pending" | "fulfilled" | "failed";
  expiresAt: string;
  fulfillmentId?: string;
}

export interface MeteredSessionRecord {
  kind: "metered-session";
  sessionId: string;
  accountId: string;
  expiresAt: string;
  maxUnits: string;
  usedUnits: string;
}

export interface SubscriptionPeriodRecord {
  kind: "subscription-period";
  subscriptionId: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  maxUnits: string;
  usedUnits: string;
}

export function createMemoryCommerceStore(): AtomicCommerceStore {
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
    get<Value>(key: string) {
      return withKeyLock(key, () => {
        const stored = values.get(key);
        return stored === undefined ? null : (JSON.parse(stored) as Value);
      });
    },
    put<Value>(key: string, value: Value) {
      return withKeyLock(key, () => {
        values.set(key, JSON.stringify(value));
      });
    },
    delete(key: string) {
      return withKeyLock(key, () => {
        values.delete(key);
      });
    },
    update<Value, Result>(
      key: string,
      fn: (current: Value | null) => CommerceStoreChange<Value, Result>,
    ) {
      return withKeyLock(key, () => {
        const stored = values.get(key);
        const current = stored === undefined ? null : (JSON.parse(stored) as Value);
        const change = fn(current);

        if (change.op === "set") values.set(key, JSON.stringify(change.value));
        if (change.op === "delete") values.delete(key);
        return change.result;
      });
    },
  };
}
