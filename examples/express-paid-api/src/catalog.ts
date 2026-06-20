import { createHash } from "node:crypto";

import {
  type PaymentContract,
  type PaymentSplit,
  validatePaymentContract,
} from "./payment-contract.js";

export const MAX_U64 = 18446744073709551615n;

export type CommerceErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CAPACITY_EXCEEDED"
  | "EXPIRED"
  | "CLOSED"
  | "RECEIPT_MISMATCH"
  | "RECEIPT_ALREADY_CLAIMED"
  | "CORRUPT_STATE";

export class CommerceError extends Error {
  constructor(
    public readonly code: CommerceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommerceError";
  }
}

export type PaymentTerms = {
  amountBaseUnits: string;
  currency: string;
  decimals?: number;
  description: string;
  recipient: string;
  splits?: PaymentSplit[];
  externalId?: string;
  expiresAt?: string;
};

export type PremiumProduct = {
  id: string;
  kind: "premium-product";
  paymentTerms: PaymentTerms;
};

export type MarketplaceProduct = {
  id: string;
  kind: "marketplace-product";
  paymentTerms: PaymentTerms;
};

export type MeteredPlan = {
  id: string;
  kind: "metered-plan";
  unitPriceBaseUnits: string;
  maxUnits: number;
  sessionTtlSeconds: number;
  paymentExpirySeconds: number;
  paymentTerms: PaymentTerms;
};

export type SubscriptionPlan = {
  id: string;
  kind: "subscription-plan";
  priceBaseUnits: string;
  periodDurationMonths: number;
  paymentExpirySeconds: number;
  paymentTerms: PaymentTerms;
};

export type CommerceCatalog = {
  premiumProducts: Map<string, PremiumProduct>;
  marketplaceProducts: Map<string, MarketplaceProduct>;
  meteredPlans: Map<string, MeteredPlan>;
  subscriptionPlans: Map<string, SubscriptionPlan>;
};

type PaymentDefaults = Pick<
  PaymentContract,
  "currency" | "decimals" | "network" | "rpcUrl" | "secretKey" | "realm"
>;

type CatalogCharge = {
  id: string;
  description: string;
  recipient: string;
  splits?: PaymentSplit[];
};

export function readCommerceCatalog(env: NodeJS.ProcessEnv): CommerceCatalog {
  const source = env.COMMERCE_CATALOG_JSON;
  if (!source) validation("Missing required environment variable: COMMERCE_CATALOG_JSON");

  let config: unknown;
  try {
    config = JSON.parse(source);
  } catch (cause) {
    throw new CommerceError("VALIDATION", "COMMERCE_CATALOG_JSON must contain valid JSON", { cause });
  }
  const root = objectValue(config, "Commerce catalog");
  const payment = readPaymentDefaults(root.payment);
  const seenIds = new Set<string>();

  const premiumProducts = new Map<string, PremiumProduct>();
  for (const value of arrayValue(root.premiumProducts, "premiumProducts")) {
    const raw = objectValue(value, "premium product");
    const entry = readCharge(raw, "premium product");
    uniqueId(entry.id, seenIds);
    const amountBaseUnits = positiveU64(raw.amountBaseUnits, "amountBaseUnits");
    premiumProducts.set(entry.id, {
      id: entry.id,
      kind: "premium-product",
      paymentTerms: validatedPublicTerms(payment, entry, amountBaseUnits),
    });
  }

  const marketplaceProducts = new Map<string, MarketplaceProduct>();
  for (const value of arrayValue(root.marketplaceProducts, "marketplaceProducts")) {
    const raw = objectValue(value, "marketplace product");
    const entry = readCharge(raw, "marketplace product");
    uniqueId(entry.id, seenIds);
    const amountBaseUnits = positiveU64(raw.amountBaseUnits, "amountBaseUnits");
    marketplaceProducts.set(entry.id, {
      id: entry.id,
      kind: "marketplace-product",
      paymentTerms: validatedPublicTerms(payment, entry, amountBaseUnits),
    });
  }

  const meteredPlans = new Map<string, MeteredPlan>();
  for (const value of arrayValue(root.meteredPlans, "meteredPlans")) {
    const raw = objectValue(value, "metered plan");
    const entry = readCharge(raw, "metered plan");
    uniqueId(entry.id, seenIds);
    const unitPriceBaseUnits = positiveU64(raw.unitPriceBaseUnits, "unitPriceBaseUnits");
    meteredPlans.set(entry.id, {
      id: entry.id,
      kind: "metered-plan",
      unitPriceBaseUnits,
      maxUnits: safePositiveInteger(raw.maxUnits, "maxUnits"),
      sessionTtlSeconds: safePositiveInteger(raw.sessionTtlSeconds, "sessionTtlSeconds"),
      paymentExpirySeconds: optionalSafePositiveInteger(raw.paymentExpirySeconds, "paymentExpirySeconds", 300),
      paymentTerms: validatedPublicTerms(payment, entry, unitPriceBaseUnits),
    });
  }

  const subscriptionPlans = new Map<string, SubscriptionPlan>();
  for (const value of arrayValue(root.subscriptionPlans, "subscriptionPlans")) {
    const raw = objectValue(value, "subscription plan");
    const entry = readCharge(raw, "subscription plan");
    uniqueId(entry.id, seenIds);
    const priceBaseUnits = positiveU64(raw.priceBaseUnits, "priceBaseUnits");
    subscriptionPlans.set(entry.id, {
      id: entry.id,
      kind: "subscription-plan",
      priceBaseUnits,
      periodDurationMonths: safePositiveInteger(raw.periodDurationMonths, "periodDurationMonths"),
      paymentExpirySeconds: optionalSafePositiveInteger(raw.paymentExpirySeconds, "paymentExpirySeconds", 300),
      paymentTerms: validatedPublicTerms(payment, entry, priceBaseUnits),
    });
  }

  if (
    premiumProducts.size === 0 || marketplaceProducts.size === 0 ||
    meteredPlans.size === 0 || subscriptionPlans.size === 0
  ) {
    validation("Commerce catalog must contain every supported entry category");
  }

  return { premiumProducts, marketplaceProducts, meteredPlans, subscriptionPlans };
}

export function paymentTermsSplitDigest(terms: Pick<PaymentTerms, "splits">): string {
  const canonical = (terms.splits ?? []).map((split) => ({
    recipient: split.recipient,
    amount: split.amount,
    ...(split.memo === undefined ? {} : { memo: split.memo }),
    ...(split.ataCreationRequired === undefined ? {} : { ataCreationRequired: split.ataCreationRequired }),
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function assertPositiveU64(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) validation(`${field} must be a positive integer decimal string`);
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_U64) validation(`${field} must be between 1 and ${MAX_U64}`);
  return parsed;
}

function readPaymentDefaults(value: unknown): PaymentDefaults {
  const raw = objectValue(value, "payment defaults");
  const currency = stringValue(raw.currency, "payment.currency");
  return {
    currency,
    ...(currency === "sol" ? {} : { decimals: safeNonNegativeInteger(raw.decimals, "payment.decimals") }),
    network: stringValue(raw.network, "payment.network") as PaymentContract["network"],
    rpcUrl: stringValue(raw.rpcUrl, "payment.rpcUrl"),
    secretKey: stringValue(raw.secretKey, "payment.secretKey"),
    realm: stringValue(raw.realm, "payment.realm"),
  };
}

function readCharge(value: unknown, field: string): CatalogCharge {
  const raw = objectValue(value, field);
  const splits = raw.splits === undefined
    ? undefined
    : arrayValue(raw.splits, `${field}.splits`).map((splitValue) => {
      const split = objectValue(splitValue, `${field}.split`);
      return {
        recipient: stringValue(split.recipient, "split.recipient"),
        amount: positiveU64(split.amount, "split.amount"),
        ...(split.memo === undefined ? {} : { memo: stringValue(split.memo, "split.memo") }),
        ...(split.ataCreationRequired === undefined
          ? {}
          : { ataCreationRequired: booleanValue(split.ataCreationRequired, "split.ataCreationRequired") }),
      };
    });
  const splitTotal = (splits ?? []).reduce((total, split) => total + BigInt(split.amount), 0n);
  if (splitTotal > MAX_U64) validation("Split total exceeds unsigned 64-bit range");
  return {
    id: stringValue(raw.id, `${field}.id`),
    description: stringValue(raw.description, `${field}.description`),
    recipient: stringValue(raw.recipient, `${field}.recipient`),
    ...(splits === undefined ? {} : { splits }),
  };
}

function validatedPublicTerms(
  defaults: PaymentDefaults,
  charge: CatalogCharge,
  amountBaseUnits: string,
): PaymentTerms {
  try {
    const contract = validatePaymentContract({
      ...defaults,
      amountBaseUnits,
      description: charge.description,
      recipient: charge.recipient,
      ...(charge.splits === undefined ? {} : { splits: charge.splits }),
    });
    return {
      amountBaseUnits: contract.amountBaseUnits,
      currency: contract.currency,
      ...(contract.decimals === undefined ? {} : { decimals: contract.decimals }),
      description: contract.description,
      recipient: contract.recipient,
      ...(contract.splits === undefined ? {} : { splits: contract.splits }),
    };
  } catch (cause) {
    throw new CommerceError(
      "VALIDATION",
      cause instanceof Error ? cause.message : "Invalid payment terms",
      { cause },
    );
  }
}

function uniqueId(id: string, seen: Set<string>): void {
  if (seen.has(id)) validation(`Duplicate catalog id: ${id}`);
  seen.add(id);
}

function positiveU64(value: unknown, field: string): string {
  const result = stringValue(value, field);
  assertPositiveU64(result, field);
  return result;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    validation(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) validation(`${field} must be an array`);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    validation(`${field} must be a non-empty string`);
  }
  return value;
}

function safePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    validation(`${field} must be a positive safe integer`);
  }
  return value;
}

function optionalSafePositiveInteger(value: unknown, field: string, fallback: number): number {
  return value === undefined ? fallback : safePositiveInteger(value, field);
}

function safeNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    validation(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") validation(`${field} must be a boolean`);
  return value;
}

function validation(message: string): never {
  throw new CommerceError("VALIDATION", message);
}
