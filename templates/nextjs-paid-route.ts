import { NextRequest, NextResponse } from "next/server";

type PaymentContract = {
  productId: string;
  amountUsd: string;
  token: "USDC";
  recipient: string;
  network: "sandbox" | "devnet" | "mainnet-beta";
};

type PaymentIntent = PaymentContract & {
  method: string;
  path: string;
  nonce: string;
  expiresAt: string;
};

type PaymentReceipt = {
  id: string;
  signature: string;
  payer: string;
  settledAt: string;
};

type PaymentVerifier = (paymentHeader: string, intent: PaymentIntent) => Promise<PaymentReceipt>;
type PaidResourceLoader = (receipt: PaymentReceipt) => Promise<Response>;

const contract: PaymentContract = {
  productId: "premium-report",
  amountUsd: "0.10",
  token: "USDC",
  recipient: requireEnv("SOLANA_PAYMENT_RECIPIENT"),
  network: (process.env.SOLANA_PAYMENT_NETWORK as PaymentContract["network"]) ?? "sandbox",
};

export async function GET(request: NextRequest) {
  const intent = buildIntent(request, contract);
  const paymentHeader = request.headers.get("x-payment");

  if (!paymentHeader) {
    return NextResponse.json(
      { error: "payment_required", intent },
      { status: 402, headers: { "X-Payment-Required": "true" } },
    );
  }

  const verifier = getConfiguredPaymentVerifier();
  const loadPaidResource = getConfiguredPaidResourceLoader();
  const receipt = await verifier(paymentHeader, intent);

  return loadPaidResource(receipt);
}

function buildIntent(request: NextRequest, payment: PaymentContract): PaymentIntent {
  return {
    method: request.method,
    path: new URL(request.url).pathname,
    productId: payment.productId,
    amountUsd: payment.amountUsd,
    token: payment.token,
    recipient: payment.recipient,
    network: payment.network,
    nonce: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

function getConfiguredPaymentVerifier(): PaymentVerifier {
  throw new Error("Configure a real Solana Pay Kit verifier before enabling this route.");
}

function getConfiguredPaidResourceLoader(): PaidResourceLoader {
  throw new Error("Configure the real paid resource loader before enabling this route.");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
