import {
  type PaymentContract,
  type PaymentSplit,
  validatePaymentContract,
} from "./payment-contract.js";

export type PremiumProduct = {
  id: string;
  kind: "premium-product";
  payment: PaymentContract;
};

export type MarketplaceProduct = {
  id: string;
  kind: "marketplace-product";
  payment: PaymentContract;
};

export type MeteredPlan = {
  id: string;
  kind: "metered-plan";
  unitPriceBaseUnits: string;
  maxUnits: number;
  sessionTtlSeconds: number;
  payment: PaymentContract;
};

export type SubscriptionPlan = {
  id: string;
  kind: "subscription-plan";
  priceBaseUnits: string;
  periodDurationMonths: number;
  payment: PaymentContract;
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
  if (!source) {
    throw new Error("Missing required environment variable: COMMERCE_CATALOG_JSON");
  }

  let config: unknown;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error("COMMERCE_CATALOG_JSON must contain valid JSON");
  }
  const root = objectValue(config, "Commerce catalog");
  const payment = readPaymentDefaults(root.payment);
  const seenIds = new Set<string>();

  const premiumProducts = new Map<string, PremiumProduct>();
  for (const value of arrayValue(root.premiumProducts, "premiumProducts")) {
    const entry = readCharge(value, "premium product");
    uniqueId(entry.id, seenIds);
    const amountBaseUnits = decimalString(objectValue(value, "premium product").amountBaseUnits, "amountBaseUnits");
    premiumProducts.set(entry.id, {
      id: entry.id,
      kind: "premium-product",
      payment: paymentContract(payment, entry, amountBaseUnits),
    });
  }

  const marketplaceProducts = new Map<string, MarketplaceProduct>();
  for (const value of arrayValue(root.marketplaceProducts, "marketplaceProducts")) {
    const entry = readCharge(value, "marketplace product");
    uniqueId(entry.id, seenIds);
    const amountBaseUnits = decimalString(objectValue(value, "marketplace product").amountBaseUnits, "amountBaseUnits");
    marketplaceProducts.set(entry.id, {
      id: entry.id,
      kind: "marketplace-product",
      payment: paymentContract(payment, entry, amountBaseUnits),
    });
  }

  const meteredPlans = new Map<string, MeteredPlan>();
  for (const value of arrayValue(root.meteredPlans, "meteredPlans")) {
    const raw = objectValue(value, "metered plan");
    const entry = readCharge(raw, "metered plan");
    uniqueId(entry.id, seenIds);
    const unitPriceBaseUnits = decimalString(raw.unitPriceBaseUnits, "unitPriceBaseUnits");
    meteredPlans.set(entry.id, {
      id: entry.id,
      kind: "metered-plan",
      unitPriceBaseUnits,
      maxUnits: safePositiveInteger(raw.maxUnits, "maxUnits"),
      sessionTtlSeconds: safePositiveInteger(raw.sessionTtlSeconds, "sessionTtlSeconds"),
      payment: paymentContract(payment, entry, unitPriceBaseUnits),
    });
  }

  const subscriptionPlans = new Map<string, SubscriptionPlan>();
  for (const value of arrayValue(root.subscriptionPlans, "subscriptionPlans")) {
    const raw = objectValue(value, "subscription plan");
    const entry = readCharge(raw, "subscription plan");
    uniqueId(entry.id, seenIds);
    const priceBaseUnits = decimalString(raw.priceBaseUnits, "priceBaseUnits");
    subscriptionPlans.set(entry.id, {
      id: entry.id,
      kind: "subscription-plan",
      priceBaseUnits,
      periodDurationMonths: safePositiveInteger(raw.periodDurationMonths, "periodDurationMonths"),
      payment: paymentContract(payment, entry, priceBaseUnits),
    });
  }

  if (
    premiumProducts.size === 0 ||
    marketplaceProducts.size === 0 ||
    meteredPlans.size === 0 ||
    subscriptionPlans.size === 0
  ) {
    throw new Error("Commerce catalog must contain every supported entry category");
  }

  return { premiumProducts, marketplaceProducts, meteredPlans, subscriptionPlans };
}

function readPaymentDefaults(value: unknown): PaymentDefaults {
  const raw = objectValue(value, "payment defaults");
  const network = stringValue(raw.network, "payment.network") as PaymentContract["network"];
  const currency = stringValue(raw.currency, "payment.currency");
  return {
    currency,
    ...(currency === "sol" ? {} : { decimals: safeNonNegativeInteger(raw.decimals, "payment.decimals") }),
    network,
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
        amount: decimalString(split.amount, "split.amount"),
        ...(split.memo === undefined ? {} : { memo: stringValue(split.memo, "split.memo") }),
        ...(split.ataCreationRequired === undefined
          ? {}
          : { ataCreationRequired: booleanValue(split.ataCreationRequired, "split.ataCreationRequired") }),
      };
    });
  return {
    id: stringValue(raw.id, `${field}.id`),
    description: stringValue(raw.description, `${field}.description`),
    recipient: stringValue(raw.recipient, `${field}.recipient`),
    ...(splits === undefined ? {} : { splits }),
  };
}

function paymentContract(
  defaults: PaymentDefaults,
  charge: CatalogCharge,
  amountBaseUnits: string,
): PaymentContract {
  return validatePaymentContract({
    ...defaults,
    amountBaseUnits,
    description: charge.description,
    recipient: charge.recipient,
    ...(charge.splits === undefined ? {} : { splits: charge.splits }),
  });
}

function uniqueId(id: string, seen: Set<string>): void {
  if (seen.has(id)) throw new Error(`Duplicate catalog id: ${id}`);
  seen.add(id);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function decimalString(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!/^\d+$/.test(result) || BigInt(result) <= 0n) {
    throw new Error(`${field} must be a positive integer decimal string`);
  }
  return result;
}

function safePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function safeNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}
