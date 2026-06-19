export type PaymentNetwork = "localnet" | "devnet" | "mainnet-beta";

export type PaymentContract = {
  amountBaseUnits: string;
  currencyMint: string;
  decimals: number;
  description: string;
  recipient: string;
  network: PaymentNetwork;
  rpcUrl: string;
  secretKey: string;
  realm: string;
};

export function readPaymentContract(env: NodeJS.ProcessEnv): PaymentContract {
  const amountBaseUnits = required(env, "PAID_ROUTE_AMOUNT_BASE_UNITS");
  if (!/^\d+$/.test(amountBaseUnits) || BigInt(amountBaseUnits) <= 0n) {
    throw new Error("PAID_ROUTE_AMOUNT_BASE_UNITS must be a positive integer");
  }

  const decimals = Number(required(env, "PAID_ROUTE_DECIMALS"));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("PAID_ROUTE_DECIMALS must be an integer from 0 through 18");
  }

  const network = env.SOLANA_PAYMENT_NETWORK ?? "localnet";
  if (!isPaymentNetwork(network)) {
    throw new Error("SOLANA_PAYMENT_NETWORK must be localnet, devnet, or mainnet-beta");
  }

  return {
    amountBaseUnits,
    currencyMint: required(env, "PAID_ROUTE_CURRENCY_MINT"),
    decimals,
    description: env.PAID_ROUTE_DESCRIPTION ?? "Paid agentic commerce endpoint",
    recipient: required(env, "SOLANA_PAYMENT_RECIPIENT"),
    network,
    rpcUrl: required(env, "SOLANA_RPC_URL"),
    secretKey: required(env, "MPP_SECRET_KEY"),
    realm: env.MPP_REALM ?? "Solana Agentic Commerce",
  };
}

function isPaymentNetwork(value: string): value is PaymentNetwork {
  return value === "localnet" || value === "devnet" || value === "mainnet-beta";
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
