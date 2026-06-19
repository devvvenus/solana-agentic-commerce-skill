import { Mppx, solana } from "@solana/mpp/server";

type PaymentRouteConfig = {
  amountBaseUnits: string;
  currencyMint: string;
  decimals: number;
  description: string;
  recipient: string;
  network: "localnet" | "devnet" | "mainnet-beta";
  rpcUrl: string;
  secretKey: string;
  realm: string;
};

const config: PaymentRouteConfig = {
  amountBaseUnits: requiredPositiveIntegerEnv("PAID_ROUTE_AMOUNT_BASE_UNITS"),
  currencyMint: requiredEnv("PAID_ROUTE_CURRENCY_MINT"),
  decimals: requiredIntegerEnv("PAID_ROUTE_DECIMALS"),
  description: process.env.PAID_ROUTE_DESCRIPTION ?? "Paid agentic commerce endpoint",
  recipient: requiredEnv("SOLANA_PAYMENT_RECIPIENT"),
  network: paymentNetwork(process.env.SOLANA_PAYMENT_NETWORK ?? "localnet"),
  rpcUrl: requiredEnv("SOLANA_RPC_URL"),
  secretKey: requiredEnv("MPP_SECRET_KEY"),
  realm: process.env.MPP_REALM ?? "Solana Agentic Commerce",
};

const mppx = Mppx.create({
  secretKey: config.secretKey,
  realm: config.realm,
  methods: [
    solana.charge({
      recipient: config.recipient,
      currency: config.currencyMint,
      decimals: config.decimals,
      network: config.network,
      rpcUrl: config.rpcUrl,
    }),
  ],
});

export async function GET(request: Request) {
  const result = await mppx.charge({
    amount: config.amountBaseUnits,
    description: config.description,
  })(request);

  if (result.status === 402) return result.challenge;

  return result.withReceipt(
    Response.json({
      ok: true,
      product: "agent-report",
      settlement: "verified-by-solana-mpp",
    }),
  );
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function requiredPositiveIntegerEnv(name: string) {
  const value = requiredEnv(name);
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requiredIntegerEnv(name: string) {
  const raw = requiredEnv(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 18) {
    throw new Error(`${name} must be an integer from 0 through 18`);
  }
  return value;
}

function paymentNetwork(value: string): PaymentRouteConfig["network"] {
  if (value === "localnet" || value === "devnet" || value === "mainnet-beta") return value;
  throw new Error("SOLANA_PAYMENT_NETWORK must be localnet, devnet, or mainnet-beta");
}
