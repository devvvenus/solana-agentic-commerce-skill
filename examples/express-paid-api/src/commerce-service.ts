import { address } from "@solana/kit";

import {
  assertPositiveU64,
  CommerceError,
  type CommerceCatalog,
  MAX_U64,
  type MeteredPlan,
  type PaymentTerms,
  paymentTermsSplitDigest,
  type SubscriptionPlan,
} from "./catalog.js";
import {
  type AtomicCommerceStore,
  type JsonObject,
  type MeteredSessionRecord,
  type ReceiptClaimRecord,
  type SubscriptionPeriodRecord,
} from "./commerce-store.js";

const verifiedPaymentBrand: unique symbol = Symbol("VerifiedPayment");

export type VerifiedPayment = Readonly<{
  operationId: string;
  externalId: string;
  receiptReference: string;
  verifiedAt: string;
  amountBaseUnits: string;
  currency: string;
  recipient: string;
  splitDigest: string;
  [verifiedPaymentBrand]: true;
}>;

export type VerifiedPaymentEvidence = Omit<VerifiedPayment, typeof verifiedPaymentBrand>;

export type CreateSessionInput = { accountId: string; planId: string };
export type PrepareSessionSettlementInput = { sessionId: string; units: number; idempotencyKey: string };
export type CancelSessionSettlementInput = { sessionId: string; idempotencyKey: string };
export type CompleteSessionSettlementInput = CancelSessionSettlementInput & { verifiedPayment: VerifiedPayment };
export type PrepareRenewalInput = { accountId: string; planId: string; period: string; idempotencyKey: string };
export type CompleteRenewalInput = PrepareRenewalInput & { verifiedPayment: VerifiedPayment };

export type OperationPaymentTerms = PaymentTerms & {
  externalId: string;
  expiresAt: string;
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
  closedAt?: string;
};

export type PreparedSessionSettlement = {
  operationId: string;
  externalId: string;
  sessionId: string;
  units: string;
  status: "pending" | "settled" | "cancelled" | "expired";
  reservationExpiresAt: string;
  paymentTerms: OperationPaymentTerms;
  receiptReference?: string;
  verifiedAt?: string;
};

export type PreparedRenewal = {
  operationId: string;
  externalId: string;
  accountId: string;
  planId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  status: "pending" | "active";
  operationExpiresAt: string;
  paymentTerms: OperationPaymentTerms;
  receiptReference?: string;
  verifiedAt?: string;
};

type ServiceOptions = {
  catalog: CommerceCatalog;
  store: AtomicCommerceStore;
  now?: () => Date;
  generateSessionId?: () => string;
};

type StoredSettlement = JsonObject & {
  operationId: string;
  externalId: string;
  units: string;
  status: "pending" | "settled" | "cancelled" | "expired";
  reservationExpiresAt: string;
  paymentTerms: JsonObject;
  receiptReference?: string;
  verifiedAt?: string;
};

type Outcome<Value> = { ok: true; value: Value } | { ok: false; error: CommerceError };

/**
 * Only the route payment-verification adapter should call this constructor.
 * On retries, Task 4 must re-check chain settlement before reconstructing this
 * value. This service validates evidence against prepared terms but does not
 * itself query or verify the chain.
 */
export function createVerifiedPaymentFromVerification(
  evidence: VerifiedPaymentEvidence,
): VerifiedPayment {
  const operationId = nonEmpty(evidence.operationId, "operationId");
  const externalId = nonEmpty(evidence.externalId, "externalId");
  const receiptReference = nonEmpty(evidence.receiptReference, "receiptReference");
  const verifiedAt = isoTimestamp(evidence.verifiedAt, "verifiedAt");
  const amountBaseUnits = evidence.amountBaseUnits;
  assertPositiveU64(amountBaseUnits, "Verified payment amount");
  const currency = nonEmpty(evidence.currency, "currency");
  const recipient = nonEmpty(evidence.recipient, "recipient");
  try {
    if (currency !== "sol") address(currency);
    address(recipient);
  } catch (cause) {
    throw new CommerceError("VALIDATION", "Verified payment contains an invalid Solana address", { cause });
  }
  const splitDigest = nonEmpty(evidence.splitDigest, "splitDigest");
  const verified = {
    operationId,
    externalId,
    receiptReference,
    verifiedAt,
    amountBaseUnits,
    currency,
    recipient,
    splitDigest,
  } as Omit<VerifiedPayment, typeof verifiedPaymentBrand> & { [verifiedPaymentBrand]?: true };
  Object.defineProperty(verified, verifiedPaymentBrand, { value: true });
  return Object.freeze(verified) as VerifiedPayment;
}

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
      const expiresAt = addSeconds(created, plan.sessionTtlSeconds, "Session expiry").toISOString();
      const record: MeteredSessionRecord = {
        kind: "metered-session",
        sessionId,
        accountId,
        planId,
        createdAt: created.toISOString(),
        expiresAt,
        maxUnits: String(plan.maxUnits),
        usedUnits: "0",
        state: "active",
        reservations: {},
      };
      const outcome = await options.store.update(`session:${sessionId}`, (current) =>
        current === null
          ? { op: "set", value: record, result: success(sessionView(record)) }
          : { op: "noop", result: failure<SessionView>("CONFLICT", "Session id already exists") },
      );
      return unwrap(outcome);
    },

    async getSession(sessionId: string): Promise<SessionView | null> {
      const record = await options.store.get(`session:${nonEmpty(sessionId, "sessionId")}`);
      if (record === null) return null;
      assertSessionRecord(record);
      return sessionView(record);
    },

    async closeSession(sessionId: string): Promise<SessionView> {
      const key = `session:${nonEmpty(sessionId, "sessionId")}` as const;
      const closedAt = validNow(now()).toISOString();
      const outcome = await options.store.update(key, (current) => {
        if (current === null) return { op: "noop", result: failure<SessionView>("NOT_FOUND", "Session not found") };
        assertSessionRecord(current);
        if (current.state === "closed") return { op: "noop", result: success(sessionView(current)) };
        const next = { ...current, state: "closed" as const, closedAt };
        return { op: "set", value: next, result: success(sessionView(next)) };
      });
      return unwrap(outcome);
    },

    async prepareSessionSettlement(input: PrepareSessionSettlementInput): Promise<PreparedSessionSettlement> {
      const sessionId = nonEmpty(input.sessionId, "sessionId");
      const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotency key");
      const units = safePositiveInteger(input.units, "Settlement units");
      const currentTime = validNow(now());
      const outcome = await options.store.update(`session:${sessionId}`, (current) => {
        if (current === null) {
          return { op: "noop", result: failure<PreparedSessionSettlement>("NOT_FOUND", "Session not found") };
        }
        assertSessionRecord(current);
        const reservations = expirePendingReservations(settlementMap(current.reservations), currentTime);
        const changedByCleanup = reservations.changed;
        const existing = ownSettlement(reservations.values, idempotencyKey);
        if (existing !== null) {
          let result: Outcome<PreparedSessionSettlement>;
          if (existing.units !== String(units)) {
            result = failure("CONFLICT", "Settlement idempotency input conflict");
          } else if (existing.status === "expired") {
            result = failure("EXPIRED", "Prepared settlement has expired");
          } else if (existing.status === "cancelled") {
            result = failure("CONFLICT", "Prepared settlement was cancelled");
          } else {
            result = success(settlementView(sessionId, existing));
          }
          return changedByCleanup
            ? { op: "set", value: { ...current, reservations: reservations.values }, result }
            : { op: "noop", result };
        }
        if (current.state === "closed") {
          return storeCleanupOrNoop(current, reservations, failure<PreparedSessionSettlement>("CLOSED", "Session is closed"));
        }
        if (current.state === "expired" || currentTime.getTime() >= parseStoredTimestamp(current.expiresAt, "session expiresAt")) {
          const expired = { ...current, state: "expired" as const, reservations: reservations.values };
          return { op: "set", value: expired, result: failure<PreparedSessionSettlement>("EXPIRED", "Session is expired") };
        }

        const reserved = Object.values(reservations.values).reduce(
          (total, operation) => total + (operation.status === "pending" ? BigInt(operation.units) : 0n),
          0n,
        );
        if (BigInt(current.usedUnits) + reserved + BigInt(units) > BigInt(current.maxUnits)) {
          return storeCleanupOrNoop(current, reservations, failure<PreparedSessionSettlement>("CAPACITY_EXCEEDED", "Session unit limit exceeded"));
        }

        const plan = meteredPlan(options.catalog, current.planId!);
        const amountBaseUnits = checkedMultiply(plan.unitPriceBaseUnits, units);
        const expiry = Math.min(
          parseStoredTimestamp(current.expiresAt, "session expiresAt"),
          addSeconds(currentTime, plan.paymentExpirySeconds, "Reservation expiry").getTime(),
        );
        const reservationExpiresAt = new Date(expiry).toISOString();
        const externalId = `session:${sessionId}:settlement:${idempotencyKey}`;
        const paymentTerms = operationTerms(plan.paymentTerms, amountBaseUnits, externalId, reservationExpiresAt);
        const operation: StoredSettlement = {
          operationId: idempotencyKey,
          externalId,
          units: String(units),
          status: "pending",
          reservationExpiresAt,
          paymentTerms: paymentTerms as unknown as JsonObject,
        };
        const next = {
          ...current,
          reservations: { ...reservations.values, [idempotencyKey]: operation },
        };
        return { op: "set", value: next, result: success(settlementView(sessionId, operation)) };
      });
      return unwrap(outcome);
    },

    async cancelSessionSettlement(input: CancelSessionSettlementInput): Promise<PreparedSessionSettlement> {
      const sessionId = nonEmpty(input.sessionId, "sessionId");
      const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotency key");
      const currentTime = validNow(now());
      const outcome = await options.store.update(`session:${sessionId}`, (current) => {
        if (current === null) return { op: "noop", result: failure<PreparedSessionSettlement>("NOT_FOUND", "Session not found") };
        assertSessionRecord(current);
        const reservations = expirePendingReservations(settlementMap(current.reservations), currentTime);
        const existing = ownSettlement(reservations.values, idempotencyKey);
        if (existing === null) {
          return storeCleanupOrNoop(current, reservations, failure<PreparedSessionSettlement>("NOT_FOUND", "Prepared settlement not found"));
        }
        if (existing.status === "expired") {
          return { op: "set", value: { ...current, reservations: reservations.values }, result: failure<PreparedSessionSettlement>("EXPIRED", "Prepared settlement has expired") };
        }
        if (existing.status === "settled") {
          return storeCleanupOrNoop(current, reservations, failure<PreparedSessionSettlement>("CONFLICT", "Settled operation cannot be cancelled"));
        }
        if (existing.status === "cancelled") {
          return storeCleanupOrNoop(current, reservations, success(settlementView(sessionId, existing)));
        }
        const cancelled = { ...existing, status: "cancelled" as const };
        const next = { ...current, reservations: { ...reservations.values, [idempotencyKey]: cancelled } };
        return { op: "set", value: next, result: success(settlementView(sessionId, cancelled)) };
      });
      return unwrap(outcome);
    },

    async completeSessionSettlement(input: CompleteSessionSettlementInput): Promise<PreparedSessionSettlement> {
      const sessionId = nonEmpty(input.sessionId, "sessionId");
      const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotency key");
      const evidence = input.verifiedPayment;
      assertVerifiedPaymentBoundary(evidence);
      return options.store.transaction((transaction) => {
        const sessionKey = `session:${sessionId}` as const;
        const current = transaction.get(sessionKey);
        if (current === null) commerceFailure("NOT_FOUND", "Session not found");
        assertSessionRecord(current);
        const reservations = settlementMap(current.reservations);
        const existing = ownSettlement(reservations, idempotencyKey);
        if (existing === null) commerceFailure("NOT_FOUND", "Prepared settlement not found");
        assertVerifiedPayment(evidence, existing);
        enforceCompletionWindow(evidence, existing, current);
        if (existing.status === "cancelled") commerceFailure("CONFLICT", "Cancelled operation cannot be completed");
        claimReceipt(transaction, evidence, validNow(now()).toISOString());

        if (existing.status === "settled") {
          if (existing.receiptReference !== evidence.receiptReference || existing.verifiedAt !== evidence.verifiedAt) {
            commerceFailure("RECEIPT_MISMATCH", "Completed settlement evidence differs from the original completion");
          }
          return settlementView(sessionId, existing);
        }
        const settled: StoredSettlement = {
          ...existing,
          status: "settled",
          receiptReference: evidence.receiptReference,
          verifiedAt: evidence.verifiedAt,
        };
        transaction.set(sessionKey, {
          ...current,
          usedUnits: (BigInt(current.usedUnits) + BigInt(existing.units)).toString(),
          reservations: { ...reservations, [idempotencyKey]: settled },
        });
        return settlementView(sessionId, settled);
      });
    },

    async prepareRenewal(input: PrepareRenewalInput): Promise<PreparedRenewal> {
      const normalized = renewalInput(input, options.catalog);
      const boundaries = periodBoundaries(normalized.period, normalized.plan.periodDurationMonths);
      const preparedAt = validNow(now());
      const operationExpiresAt = addSeconds(preparedAt, normalized.plan.paymentExpirySeconds, "Renewal expiry").toISOString();
      const externalId = `subscription:${normalized.accountId}:${normalized.planId}:${normalized.period}:renewal:${normalized.idempotencyKey}`;
      const paymentTerms = operationTerms(normalized.plan.paymentTerms, normalized.plan.priceBaseUnits, externalId, operationExpiresAt);
      const key = renewalKey(normalized.accountId, normalized.planId, normalized.period);
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
        operationExpiresAt,
        paymentTerms: paymentTerms as unknown as JsonObject,
      };
      const outcome = await options.store.update(key, (current) => {
        if (current !== null) {
          assertSubscriptionRecord(current);
          const currentExpiresAt = parseStoredTimestamp(
            requiredStored(current.operationExpiresAt, "renewal operationExpiresAt"),
            "renewal operationExpiresAt",
          );
          if (current.status === "pending" && preparedAt.getTime() > currentExpiresAt) {
            return { op: "set", value: record, result: success(renewalView(record)) };
          }
          if (current.idempotencyKey === normalized.idempotencyKey) return { op: "noop", result: success(renewalView(current)) };
          return {
            op: "noop",
            result: failure<PreparedRenewal>("CONFLICT", current.status === "active"
              ? "A second operation for an active period is not allowed"
              : "Renewal idempotency conflict"),
          };
        }
        return { op: "set", value: record, result: success(renewalView(record)) };
      });
      return unwrap(outcome);
    },

    async completeRenewal(input: CompleteRenewalInput): Promise<PreparedRenewal> {
      const normalized = renewalInput(input, options.catalog);
      const evidence = input.verifiedPayment;
      assertVerifiedPaymentBoundary(evidence);
      return options.store.transaction((transaction) => {
        const key = renewalKey(normalized.accountId, normalized.planId, normalized.period);
        const current = transaction.get(key);
        if (current === null) commerceFailure("NOT_FOUND", "Prepared renewal not found");
        assertSubscriptionRecord(current);
        if (current.idempotencyKey !== normalized.idempotencyKey) commerceFailure("CONFLICT", "Renewal idempotency conflict");
        const operation = renewalOperation(current);
        assertVerifiedPayment(evidence, operation);
        if (Date.parse(evidence.verifiedAt) > Date.parse(operation.reservationExpiresAt)) {
          commerceFailure("EXPIRED", "Renewal payment was verified after operation expiry");
        }
        claimReceipt(transaction, evidence, validNow(now()).toISOString());
        if (current.status === "active") {
          if (current.receiptReference !== evidence.receiptReference || current.verifiedAt !== evidence.verifiedAt) {
            commerceFailure("RECEIPT_MISMATCH", "Completed renewal evidence differs from the original completion");
          }
          return renewalView(current);
        }
        const next = {
          ...current,
          status: "active" as const,
          receiptReference: evidence.receiptReference,
          verifiedAt: evidence.verifiedAt,
        };
        transaction.set(key, next);
        return renewalView(next);
      });
    },
  };
}

function claimReceipt(
  transaction: Parameters<AtomicCommerceStore["transaction"]>[0] extends (value: infer T) => unknown ? T : never,
  evidence: VerifiedPayment,
  claimedAt: string,
): void {
  const key = `receipt-claim:${encodeURIComponent(evidence.receiptReference)}` as const;
  const existing = transaction.get(key);
  if (existing !== null && existing.externalId !== evidence.externalId) {
    commerceFailure("RECEIPT_ALREADY_CLAIMED", "Receipt reference is already claimed by another operation");
  }
  if (existing === null) {
    const claim: ReceiptClaimRecord = {
      kind: "receipt-claim",
      receiptReference: evidence.receiptReference,
      operationId: evidence.operationId,
      externalId: evidence.externalId,
      claimedAt,
    };
    transaction.set(key, claim);
  }
}

function assertVerifiedPaymentBoundary(value: VerifiedPayment): void {
  if (
    value === null ||
    typeof value !== "object" ||
    value[verifiedPaymentBrand] !== true
  ) {
    commerceFailure("VALIDATION", "Verified payment must be created by the verification boundary");
  }
}

function assertVerifiedPayment(evidence: VerifiedPayment, operation: StoredSettlement): void {
  const terms = storedTerms(operation.paymentTerms);
  if (
    evidence.operationId !== operation.operationId ||
    evidence.externalId !== operation.externalId ||
    evidence.amountBaseUnits !== terms.amountBaseUnits ||
    evidence.currency !== terms.currency ||
    evidence.recipient !== terms.recipient ||
    evidence.splitDigest !== paymentTermsSplitDigest(terms)
  ) {
    commerceFailure("RECEIPT_MISMATCH", "Verified payment does not match prepared payment terms");
  }
}

function enforceCompletionWindow(
  evidence: VerifiedPayment,
  operation: StoredSettlement,
  session: MeteredSessionRecord,
): void {
  const verifiedAt = Date.parse(evidence.verifiedAt);
  if (verifiedAt > parseStoredTimestamp(operation.reservationExpiresAt, "reservation expiry")) {
    commerceFailure("EXPIRED", "Payment was verified after reservation expiry");
  }
  if (session.state === "closed") {
    const closedAt = parseStoredTimestamp(requiredStored(session.closedAt, "session closedAt"), "session closedAt");
    if (verifiedAt > closedAt) commerceFailure("CLOSED", "Payment was verified after the session closed");
  }
}

function checkedMultiply(unitPriceBaseUnits: string, units: number): string {
  const price = assertPositiveU64(unitPriceBaseUnits, "Unit price");
  const quantity = BigInt(units);
  if (price > MAX_U64 / quantity) commerceFailure("VALIDATION", "Computed charge exceeds unsigned 64-bit range");
  return (price * quantity).toString();
}

function operationTerms(
  base: PaymentTerms,
  amountBaseUnits: string,
  externalId: string,
  expiresAt: string,
): OperationPaymentTerms {
  assertPositiveU64(amountBaseUnits, "Payment amount");
  return { ...base, amountBaseUnits, externalId, expiresAt };
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
  if (!Number.isSafeInteger(endMonth)) commerceFailure("VALIDATION", "Billing period duration exceeds safe calendar arithmetic");
  const start = utcMonthStart(firstMonth);
  const end = utcMonthStart(endMonth);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    commerceFailure("VALIDATION", "Billing period exceeds the supported timestamp range");
  }
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

function utcMonthStart(absoluteMonth: number): Date {
  const value = new Date(0);
  value.setUTCFullYear(Math.floor(absoluteMonth / 12), absoluteMonth % 12, 1);
  return value;
}

function parsePeriod(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) commerceFailure("VALIDATION", "Billing period must use strict YYYY-MM format");
  return period;
}

function renewalKey(accountId: string, planId: string, period: string) {
  return `subscription:${encodeURIComponent(accountId)}:${encodeURIComponent(planId)}:${period}` as const;
}

function meteredPlan(catalog: CommerceCatalog, planId: string): MeteredPlan {
  const plan = catalog.meteredPlans.get(planId);
  if (!plan) commerceFailure("NOT_FOUND", `Unknown metered plan: ${planId}`);
  return plan;
}

function subscriptionPlan(catalog: CommerceCatalog, planId: string): SubscriptionPlan {
  const plan = catalog.subscriptionPlans.get(planId);
  if (!plan) commerceFailure("NOT_FOUND", `Unknown subscription plan: ${planId}`);
  return plan;
}

function expirePendingReservations(
  reservations: Record<string, StoredSettlement>,
  currentTime: Date,
): { values: Record<string, StoredSettlement>; changed: boolean } {
  let changed = false;
  const values = Object.fromEntries(Object.entries(reservations).map(([key, operation]) => {
    assertStoredSettlement(operation);
    if (operation.status === "pending" && currentTime.getTime() >= Date.parse(operation.reservationExpiresAt)) {
      changed = true;
      return [key, { ...operation, status: "expired" as const }];
    }
    return [key, operation];
  }));
  return { values, changed };
}

function storeCleanupOrNoop<Value>(
  current: MeteredSessionRecord,
  reservations: { values: Record<string, StoredSettlement>; changed: boolean },
  result: Outcome<Value>,
) {
  return reservations.changed
    ? { op: "set" as const, value: { ...current, reservations: reservations.values }, result }
    : { op: "noop" as const, result };
}

function settlementMap(value: JsonObject | undefined): Record<string, StoredSettlement> {
  if (value === undefined || value === null || Array.isArray(value)) commerceFailure("CORRUPT_STATE", "Stored reservations are invalid");
  return value as Record<string, StoredSettlement>;
}

function ownSettlement(reservations: Record<string, StoredSettlement>, key: string): StoredSettlement | null {
  return Object.hasOwn(reservations, key) ? reservations[key] : null;
}

function settlementView(sessionId: string, stored: StoredSettlement): PreparedSessionSettlement {
  assertStoredSettlement(stored);
  return {
    operationId: stored.operationId,
    externalId: stored.externalId,
    sessionId,
    units: stored.units,
    status: stored.status,
    reservationExpiresAt: stored.reservationExpiresAt,
    paymentTerms: storedTerms(stored.paymentTerms),
    ...(stored.receiptReference === undefined ? {} : { receiptReference: stored.receiptReference }),
    ...(stored.verifiedAt === undefined ? {} : { verifiedAt: stored.verifiedAt }),
  };
}

function sessionView(record: MeteredSessionRecord): SessionView {
  return {
    sessionId: record.sessionId,
    accountId: record.accountId,
    planId: requiredStored(record.planId, "session planId"),
    createdAt: requiredStored(record.createdAt, "session createdAt"),
    expiresAt: record.expiresAt,
    maxUnits: record.maxUnits,
    usedUnits: record.usedUnits,
    state: record.state ?? "active",
    ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }),
  };
}

function renewalOperation(record: SubscriptionPeriodRecord): StoredSettlement {
  const paymentTerms = requiredStored(record.paymentTerms, "renewal paymentTerms");
  const terms = storedTerms(paymentTerms);
  return {
    operationId: requiredStored(record.idempotencyKey, "renewal idempotencyKey"),
    externalId: terms.externalId,
    units: "0",
    status: record.status === "active" ? "settled" : "pending",
    reservationExpiresAt: requiredStored(record.operationExpiresAt, "renewal operationExpiresAt"),
    paymentTerms,
    ...(record.receiptReference === undefined ? {} : { receiptReference: record.receiptReference }),
    ...(record.verifiedAt === undefined ? {} : { verifiedAt: record.verifiedAt }),
  };
}

function renewalView(record: SubscriptionPeriodRecord): PreparedRenewal {
  const operation = renewalOperation(record);
  return {
    operationId: operation.operationId,
    externalId: operation.externalId,
    accountId: record.accountId,
    planId: requiredStored(record.planId, "renewal planId"),
    period: requiredStored(record.period, "renewal period"),
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    status: record.status ?? "pending",
    operationExpiresAt: operation.reservationExpiresAt,
    paymentTerms: storedTerms(operation.paymentTerms),
    ...(operation.receiptReference === undefined ? {} : { receiptReference: operation.receiptReference }),
    ...(operation.verifiedAt === undefined ? {} : { verifiedAt: operation.verifiedAt }),
  };
}

function storedTerms(value: JsonObject): OperationPaymentTerms {
  const terms = value as unknown as OperationPaymentTerms;
  assertPositiveU64(terms.amountBaseUnits, "Stored payment amount");
  nonEmpty(terms.currency, "stored payment currency");
  nonEmpty(terms.description, "stored payment description");
  nonEmpty(terms.recipient, "stored payment recipient");
  nonEmpty(terms.externalId, "stored payment externalId");
  isoTimestamp(terms.expiresAt, "stored payment expiresAt");
  return terms;
}

function assertSessionRecord(record: MeteredSessionRecord): void {
  try {
    requiredStored(record.planId, "session planId");
    isoTimestamp(requiredStored(record.createdAt, "session createdAt"), "session createdAt");
    isoTimestamp(record.expiresAt, "session expiresAt");
    decimalNonNegative(record.usedUnits, "session usedUnits");
    const maxUnits = decimalNonNegative(record.maxUnits, "session maxUnits");
    if (maxUnits === 0n) throw new Error("maxUnits must be positive");
    if (record.state !== undefined && !["active", "expired", "closed"].includes(record.state)) throw new Error("state is invalid");
    settlementMap(record.reservations);
  } catch (cause) {
    if (cause instanceof CommerceError && cause.code === "CORRUPT_STATE") throw cause;
    throw new CommerceError("CORRUPT_STATE", "Stored session state is invalid", { cause });
  }
}

function assertSubscriptionRecord(record: SubscriptionPeriodRecord): void {
  try {
    requiredStored(record.planId, "renewal planId");
    requiredStored(record.period, "renewal period");
    requiredStored(record.idempotencyKey, "renewal idempotencyKey");
    requiredStored(record.paymentTerms, "renewal paymentTerms");
    isoTimestamp(requiredStored(record.operationExpiresAt, "renewal operationExpiresAt"), "renewal operationExpiresAt");
    if (record.status !== "pending" && record.status !== "active") throw new Error("status is invalid");
  } catch (cause) {
    throw new CommerceError("CORRUPT_STATE", "Stored renewal state is invalid", { cause });
  }
}

function assertStoredSettlement(operation: StoredSettlement): void {
  try {
    nonEmpty(operation.operationId, "stored operationId");
    nonEmpty(operation.externalId, "stored externalId");
    decimalNonNegative(operation.units, "stored units");
    isoTimestamp(operation.reservationExpiresAt, "stored reservation expiry");
    storedTerms(operation.paymentTerms);
    if (!["pending", "settled", "cancelled", "expired"].includes(operation.status)) throw new Error("status is invalid");
  } catch (cause) {
    throw new CommerceError("CORRUPT_STATE", "Stored settlement state is invalid", { cause });
  }
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) commerceFailure("VALIDATION", `${field} must be a non-empty string`);
  return value;
}

function safePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) commerceFailure("VALIDATION", `${field} must be a positive safe integer`);
  return value;
}

function decimalNonNegative(value: string, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${field} must be a decimal string`);
  return BigInt(value);
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) commerceFailure("VALIDATION", "Current time must be a valid Date");
  return value;
}

function addSeconds(value: Date, seconds: number, field: string): Date {
  const result = new Date(value.getTime() + seconds * 1000);
  if (!Number.isFinite(result.getTime())) commerceFailure("VALIDATION", `${field} exceeds the supported timestamp range`);
  return result;
}

function isoTimestamp(value: string, field: string): string {
  if (typeof value !== "string") commerceFailure("VALIDATION", `${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    commerceFailure("VALIDATION", `${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function parseStoredTimestamp(value: string, field: string): number {
  try {
    return Date.parse(isoTimestamp(value, field));
  } catch (cause) {
    throw new CommerceError("CORRUPT_STATE", `Stored ${field} is invalid`, { cause });
  }
}

function requiredStored<Value>(value: Value | undefined, field: string): Value {
  if (value === undefined) commerceFailure("CORRUPT_STATE", `Stored ${field} is missing`);
  return value;
}

function success<Value>(value: Value): Outcome<Value> { return { ok: true, value }; }
function failure<Value>(code: CommerceError["code"], message: string): Outcome<Value> {
  return { ok: false, error: new CommerceError(code, message) };
}
function unwrap<Value>(outcome: Outcome<Value>): Value {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
function commerceFailure(code: CommerceError["code"], message: string): never {
  throw new CommerceError(code, message);
}
