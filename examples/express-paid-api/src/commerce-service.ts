import type { CommerceCatalog, MeteredPlan, SubscriptionPlan } from "./catalog.js";
import {
  type AtomicCommerceStore,
  type JsonObject,
  type MeteredSessionRecord,
  type SubscriptionPeriodRecord,
} from "./commerce-store.js";
import { type PaymentContract, validatePaymentContract } from "./payment-contract.js";

export type CreateSessionInput = {
  accountId: string;
  planId: string;
};

export type PrepareSessionSettlementInput = {
  sessionId: string;
  units: number;
  idempotencyKey: string;
};

export type CompleteSessionSettlementInput = {
  sessionId: string;
  idempotencyKey: string;
  verifiedReceiptReference: string;
};

export type PrepareRenewalInput = {
  accountId: string;
  planId: string;
  period: string;
  idempotencyKey: string;
};

export type CompleteRenewalInput = PrepareRenewalInput & {
  verifiedReceiptReference: string;
};

export type SessionView = {
  sessionId: string;
  accountId: string;
  planId: string;
  createdAt: string;
  expiresAt: string;
  maxUnits: string;
  usedUnits: string;
  state: "active" | "expired" | "closed";
};

export type PreparedSessionSettlement = {
  operationId: string;
  sessionId: string;
  units: string;
  status: "pending" | "settled";
  payment: PaymentContract;
  verifiedReceiptReference?: string;
};

export type PreparedRenewal = {
  operationId: string;
  accountId: string;
  planId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  status: "pending" | "active";
  payment: PaymentContract;
  verifiedReceiptReference?: string;
};

export type CommerceService = ReturnType<typeof createCommerceService>;

type ServiceOptions = {
  catalog: CommerceCatalog;
  store: AtomicCommerceStore;
  now?: () => Date;
  generateSessionId?: () => string;
};

type StoredSettlement = JsonObject & {
  operationId: string;
  units: string;
  status: "pending" | "settled";
  payment: JsonObject;
  verifiedReceiptReference?: string;
};

type Outcome<Value> =
  | { ok: true; value: Value }
  | { ok: false; message: string };

export function createCommerceService(options: ServiceOptions) {
  const now = options.now ?? (() => new Date());
  const generateSessionId = options.generateSessionId ?? (() => crypto.randomUUID());

  return {
    async createSession(input: CreateSessionInput): Promise<SessionView> {
      const accountId = nonEmpty(input.accountId, "accountId");
      const planId = nonEmpty(input.planId, "planId");
      const plan = meteredPlan(options.catalog, planId);
      const sessionId = nonEmpty(generateSessionId(), "generated sessionId");
      const created = validNow(now());
      const expires = new Date(created.getTime() + plan.sessionTtlSeconds * 1000);
      if (!Number.isFinite(expires.getTime())) {
        throw new Error("Session expiry exceeds the supported timestamp range");
      }
      const record: MeteredSessionRecord = {
        kind: "metered-session",
        sessionId,
        accountId,
        planId,
        createdAt: created.toISOString(),
        expiresAt: expires.toISOString(),
        maxUnits: String(plan.maxUnits),
        usedUnits: "0",
        state: "active",
        reservations: {},
      };
      const outcome = await options.store.update(`session:${sessionId}`, (current) =>
        current === null
          ? { op: "set", value: record, result: success(sessionView(record)) }
          : { op: "noop", result: failure<SessionView>("Session id already exists") },
      );
      return unwrap(outcome);
    },

    async getSession(sessionId: string): Promise<SessionView | null> {
      const record = await options.store.get(`session:${nonEmpty(sessionId, "sessionId")}`);
      return record === null ? null : sessionView(record);
    },

    async closeSession(sessionId: string): Promise<SessionView> {
      const key = `session:${nonEmpty(sessionId, "sessionId")}` as const;
      const outcome = await options.store.update(key, (current) => {
        if (current === null) return { op: "noop", result: failure<SessionView>("Session not found") };
        const next = { ...current, state: "closed" as const };
        return { op: "set", value: next, result: success(sessionView(next)) };
      });
      return unwrap(outcome);
    },

    async prepareSessionSettlement(
      input: PrepareSessionSettlementInput,
    ): Promise<PreparedSessionSettlement> {
      const sessionId = nonEmpty(input.sessionId, "sessionId");
      const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotency key");
      const units = safePositiveInteger(input.units, "Settlement units");
      const key = `session:${sessionId}` as const;
      const currentTime = validNow(now());
      const outcome = await options.store.update(key, (current) => {
        if (current === null) {
          return { op: "noop", result: failure<PreparedSessionSettlement>("Session not found") };
        }
        const plan = meteredPlan(options.catalog, requiredRecordField(current.planId, "session planId"));
        const reservations = settlementMap(current.reservations);
        const existing = ownSettlement(reservations, idempotencyKey);
        if (existing !== null) {
          if (existing.units !== String(units)) {
            return { op: "noop", result: failure<PreparedSessionSettlement>("Settlement idempotency conflict") };
          }
          return { op: "noop", result: success(settlementView(sessionId, existing)) };
        }
        if (current.state === "closed") {
          return { op: "noop", result: failure<PreparedSessionSettlement>("Session is closed") };
        }
        if (current.state === "expired" || currentTime.getTime() >= Date.parse(current.expiresAt)) {
          const expired = { ...current, state: "expired" as const };
          return { op: "set", value: expired, result: failure<PreparedSessionSettlement>("Session is expired") };
        }

        const reservedUnits = Object.values(reservations).reduce(
          (total, reservation) => total + (reservation.status === "pending" ? BigInt(reservation.units) : 0n),
          0n,
        );
        if (BigInt(current.usedUnits) + reservedUnits + BigInt(units) > BigInt(current.maxUnits)) {
          return { op: "noop", result: failure<PreparedSessionSettlement>("Session unit limit exceeded") };
        }

        const amountBaseUnits = (BigInt(plan.unitPriceBaseUnits) * BigInt(units)).toString();
        const payment = pricedPayment(plan, amountBaseUnits, `${sessionId}:${idempotencyKey}`);
        const operation: StoredSettlement = {
          operationId: idempotencyKey,
          units: String(units),
          status: "pending",
          payment: payment as unknown as JsonObject,
        };
        const next = {
          ...current,
          reservations: { ...reservations, [idempotencyKey]: operation },
        };
        return {
          op: "set",
          value: next,
          result: success(settlementView(sessionId, operation)),
        };
      });
      return unwrap(outcome);
    },

    async completeSessionSettlement(
      input: CompleteSessionSettlementInput,
    ): Promise<PreparedSessionSettlement> {
      const sessionId = nonEmpty(input.sessionId, "sessionId");
      const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotency key");
      const receipt = nonEmpty(input.verifiedReceiptReference, "verifiedReceiptReference");
      const outcome = await options.store.update(`session:${sessionId}`, (current) => {
        if (current === null) {
          return { op: "noop", result: failure<PreparedSessionSettlement>("Session not found") };
        }
        const reservations = settlementMap(current.reservations);
        const existing = ownSettlement(reservations, idempotencyKey);
        if (existing === null) {
          return { op: "noop", result: failure<PreparedSessionSettlement>("Prepared settlement not found") };
        }
        if (existing.status === "settled") {
          if (existing.verifiedReceiptReference !== receipt) {
            return { op: "noop", result: failure<PreparedSessionSettlement>("Settlement receipt conflict") };
          }
          return { op: "noop", result: success(settlementView(sessionId, existing)) };
        }

        const settled: StoredSettlement = {
          ...existing,
          status: "settled",
          verifiedReceiptReference: receipt,
        };
        const next = {
          ...current,
          usedUnits: (BigInt(current.usedUnits) + BigInt(existing.units)).toString(),
          reservations: { ...reservations, [idempotencyKey]: settled },
        };
        return {
          op: "set",
          value: next,
          result: success(settlementView(sessionId, settled)),
        };
      });
      return unwrap(outcome);
    },

    async prepareRenewal(input: PrepareRenewalInput): Promise<PreparedRenewal> {
      const normalized = renewalInput(input, options.catalog);
      const boundaries = periodBoundaries(normalized.period, normalized.plan.periodDurationMonths);
      const key = renewalKey(normalized.accountId, normalized.planId, normalized.period);
      const payment = pricedPayment(
        normalized.plan,
        normalized.plan.priceBaseUnits,
        `${normalized.accountId}:${normalized.planId}:${normalized.period}`,
      );
      const outcome = await options.store.update(key, (current) => {
        if (current !== null) {
          if (current.idempotencyKey === normalized.idempotencyKey) {
            return { op: "noop", result: success(renewalView(current)) };
          }
          const message = current.status === "active"
            ? "A second operation for an active period is not allowed"
            : "Renewal idempotency conflict";
          return { op: "noop", result: failure<PreparedRenewal>(message) };
        }
        const record: SubscriptionPeriodRecord = {
          kind: "subscription-period",
          subscriptionId: `${normalized.accountId}:${normalized.planId}`,
          accountId: normalized.accountId,
          planId: normalized.planId,
          period: normalized.period,
          periodStart: boundaries.periodStart,
          periodEnd: boundaries.periodEnd,
          maxUnits: "0",
          usedUnits: "0",
          idempotencyKey: normalized.idempotencyKey,
          status: "pending",
          payment: payment as unknown as JsonObject,
        };
        return { op: "set", value: record, result: success(renewalView(record)) };
      });
      return unwrap(outcome);
    },

    async completeRenewal(input: CompleteRenewalInput): Promise<PreparedRenewal> {
      const normalized = renewalInput(input, options.catalog);
      const receipt = nonEmpty(input.verifiedReceiptReference, "verifiedReceiptReference");
      const key = renewalKey(normalized.accountId, normalized.planId, normalized.period);
      const outcome = await options.store.update(key, (current) => {
        if (current === null) {
          return { op: "noop", result: failure<PreparedRenewal>("Prepared renewal not found") };
        }
        if (current.idempotencyKey !== normalized.idempotencyKey) {
          return { op: "noop", result: failure<PreparedRenewal>("Renewal idempotency conflict") };
        }
        if (current.status === "active") {
          if (current.verifiedReceiptReference !== receipt) {
            return { op: "noop", result: failure<PreparedRenewal>("Renewal receipt conflict") };
          }
          return { op: "noop", result: success(renewalView(current)) };
        }
        const next = {
          ...current,
          status: "active" as const,
          verifiedReceiptReference: receipt,
        };
        return { op: "set", value: next, result: success(renewalView(next)) };
      });
      return unwrap(outcome);
    },
  };
}

function renewalInput(input: PrepareRenewalInput, catalog: CommerceCatalog) {
  const accountId = nonEmpty(input.accountId, "accountId");
  const planId = nonEmpty(input.planId, "planId");
  return {
    accountId,
    planId,
    period: parsePeriod(input.period),
    idempotencyKey: nonEmpty(input.idempotencyKey, "idempotency key"),
    plan: subscriptionPlan(catalog, planId),
  };
}

function periodBoundaries(period: string, durationMonths: number) {
  const [yearText, monthText] = period.split("-");
  const firstMonth = Number(yearText) * 12 + Number(monthText) - 1;
  const endMonth = firstMonth + durationMonths;
  if (!Number.isSafeInteger(endMonth)) {
    throw new Error("Billing period duration exceeds safe calendar arithmetic");
  }
  const start = utcMonthStart(firstMonth);
  const end = utcMonthStart(endMonth);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("Billing period exceeds the supported timestamp range");
  }
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

function utcMonthStart(absoluteMonth: number): Date {
  const value = new Date(0);
  value.setUTCFullYear(Math.floor(absoluteMonth / 12), absoluteMonth % 12, 1);
  return value;
}

function parsePeriod(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new Error("Billing period must use strict YYYY-MM format");
  }
  return period;
}

function renewalKey(accountId: string, planId: string, period: string) {
  return `subscription:${encodeURIComponent(accountId)}:${encodeURIComponent(planId)}:${period}` as const;
}

function meteredPlan(catalog: CommerceCatalog, planId: string): MeteredPlan {
  const plan = catalog.meteredPlans.get(planId);
  if (!plan) throw new Error(`Unknown metered plan: ${planId}`);
  return plan;
}

function subscriptionPlan(catalog: CommerceCatalog, planId: string): SubscriptionPlan {
  const plan = catalog.subscriptionPlans.get(planId);
  if (!plan) throw new Error(`Unknown subscription plan: ${planId}`);
  return plan;
}

function pricedPayment(
  plan: MeteredPlan | SubscriptionPlan,
  amountBaseUnits: string,
  externalId: string,
): PaymentContract {
  return validatePaymentContract({ ...plan.payment, amountBaseUnits, externalId });
}

function settlementMap(value: JsonObject | undefined): Record<string, StoredSettlement> {
  return (value ?? {}) as Record<string, StoredSettlement>;
}

function ownSettlement(
  reservations: Record<string, StoredSettlement>,
  key: string,
): StoredSettlement | null {
  return Object.hasOwn(reservations, key) ? reservations[key] : null;
}

function settlementView(sessionId: string, stored: StoredSettlement): PreparedSessionSettlement {
  return {
    operationId: stored.operationId,
    sessionId,
    units: stored.units,
    status: stored.status,
    payment: stored.payment as unknown as PaymentContract,
    ...(stored.verifiedReceiptReference === undefined
      ? {}
      : { verifiedReceiptReference: stored.verifiedReceiptReference }),
  };
}

function sessionView(record: MeteredSessionRecord): SessionView {
  return {
    sessionId: record.sessionId,
    accountId: record.accountId,
    planId: requiredRecordField(record.planId, "session planId"),
    createdAt: requiredRecordField(record.createdAt, "session createdAt"),
    expiresAt: record.expiresAt,
    maxUnits: record.maxUnits,
    usedUnits: record.usedUnits,
    state: record.state ?? "active",
  };
}

function renewalView(record: SubscriptionPeriodRecord): PreparedRenewal {
  return {
    operationId: requiredRecordField(record.idempotencyKey, "renewal idempotencyKey"),
    accountId: record.accountId,
    planId: requiredRecordField(record.planId, "renewal planId"),
    period: requiredRecordField(record.period, "renewal period"),
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    status: record.status ?? "pending",
    payment: requiredRecordField(record.payment, "renewal payment") as unknown as PaymentContract,
    ...(record.verifiedReceiptReference === undefined
      ? {}
      : { verifiedReceiptReference: record.verifiedReceiptReference }),
  };
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function safePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("Current time must be a valid Date");
  return value;
}

function requiredRecordField<Value>(value: Value | undefined, field: string): Value {
  if (value === undefined) throw new Error(`Stored ${field} is missing`);
  return value;
}

function success<Value>(value: Value): Outcome<Value> {
  return { ok: true, value };
}

function failure<Value>(message: string): Outcome<Value> {
  return { ok: false, message };
}

function unwrap<Value>(outcome: Outcome<Value>): Value {
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.value;
}
