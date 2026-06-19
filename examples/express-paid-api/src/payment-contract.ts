import { address } from "@solana/kit";

export type PaymentNetwork = "localnet" | "devnet" | "mainnet-beta";

export type PaymentSplit = {
  recipient: string;
  amount: string;
  memo?: string;
  ataCreationRequired?: boolean;
};

export type PaymentContract = {
  amountBaseUnits: string;
  currency: string;
  decimals?: number;
  description: string;
  recipient: string;
  network: PaymentNetwork;
  rpcUrl: string;
  secretKey: string;
  realm: string;
  externalId?: string;
  expiresInSeconds?: number;
  splits?: PaymentSplit[];
};

export function readPaymentContract(env: NodeJS.ProcessEnv): PaymentContract {
  const amountBaseUnits = required(env, "PAID_ROUTE_AMOUNT_BASE_UNITS");
  if (!/^\d+$/.test(amountBaseUnits) || BigInt(amountBaseUnits) <= 0n) {
    throw new Error("PAID_ROUTE_AMOUNT_BASE_UNITS must be a positive integer");
  }

  const currency = env.PAID_ROUTE_CURRENCY ?? env.PAID_ROUTE_CURRENCY_MINT;
  if (!currency) {
    throw new Error("Missing required environment variable: PAID_ROUTE_CURRENCY");
  }

  const decimals = currency === "sol" ? undefined : readDecimals(env);

  const network = env.SOLANA_PAYMENT_NETWORK ?? "localnet";
  if (!isPaymentNetwork(network)) {
    throw new Error("SOLANA_PAYMENT_NETWORK must be localnet, devnet, or mainnet-beta");
  }

  return validatePaymentContract({
    amountBaseUnits,
    currency,
    decimals,
    description: env.PAID_ROUTE_DESCRIPTION ?? "Paid agentic commerce endpoint",
    recipient: required(env, "SOLANA_PAYMENT_RECIPIENT"),
    network,
    rpcUrl: required(env, "SOLANA_RPC_URL"),
    secretKey: required(env, "MPP_SECRET_KEY"),
    realm: env.MPP_REALM ?? "Solana Agentic Commerce",
  });
}

export function validatePaymentContract(
  contract: PaymentContract,
): PaymentContract {
  const amountBaseUnits = positiveInteger(
    contract.amountBaseUnits,
    "Payment amount",
  );

  if (contract.currency !== "sol") {
    validateDecimals(contract.decimals);
  }

  if (!isPaymentNetwork(contract.network)) {
    throw new Error("Payment network must be localnet, devnet, or mainnet-beta");
  }

  address(contract.recipient);

  if (contract.secretKey.length < 32) {
    throw new Error("Payment secret must be at least 32 characters");
  }

  const splits = contract.splits ?? [];
  if (splits.length > 8) {
    throw new Error("Payment contract supports at most 8 splits");
  }

  let splitTotal = 0n;
  for (const split of splits) {
    address(split.recipient);
    splitTotal += positiveInteger(split.amount, "Split amount");
  }

  if (splitTotal >= amountBaseUnits) {
    throw new Error("Split total must be less than the charge amount");
  }

  return contract;
}

function readDecimals(env: NodeJS.ProcessEnv): number {
  const decimals = Number(required(env, "PAID_ROUTE_DECIMALS"));
  validateDecimals(decimals, "PAID_ROUTE_DECIMALS");
  return decimals;
}

function validateDecimals(
  decimals: number | undefined,
  field = "Payment contract decimals",
): void {
  if (
    !Number.isInteger(decimals) ||
    decimals === undefined ||
    decimals < 0 ||
    decimals > 18
  ) {
    throw new Error(`${field} must be an integer from 0 through 18`);
  }
}

function positiveInteger(value: string, field: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${field} must be a positive integer`);
  }
  return BigInt(value);
}

function isPaymentNetwork(value: string): value is PaymentNetwork {
  return value === "localnet" || value === "devnet" || value === "mainnet-beta";
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
