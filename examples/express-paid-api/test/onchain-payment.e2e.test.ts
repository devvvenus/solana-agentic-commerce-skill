import type { Server } from "node:http";
import { generateKeyPairSigner } from "@solana/kit";
import { Mppx, solana } from "@solana/mpp/client";
import { Receipt } from "mppx";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

const rpcUrl = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
const paymentAmountLamports = 25_000n;

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
});

describe("paid Express route on Surfpool", () => {
  it("settles a native SOL payment on-chain before returning paid content", async () => {
    await assertRpcReady(rpcUrl);

    const payer = await generateKeyPairSigner();
    const recipient = await generateKeyPairSigner();

    await requestAirdrop(rpcUrl, payer.address, 1_000_000_000n);
    await requestAirdrop(rpcUrl, recipient.address, 1_000_000n);
    await waitForBalanceAtLeast(rpcUrl, payer.address, 1_000_000_000n);
    const recipientBalanceBefore = await waitForBalanceAtLeast(rpcUrl, recipient.address, 1_000_000n);

    const app = createServer({
      PAID_ROUTE_AMOUNT_BASE_UNITS: paymentAmountLamports.toString(),
      PAID_ROUTE_CURRENCY: "sol",
      SOLANA_PAYMENT_NETWORK: "localnet",
      SOLANA_PAYMENT_RECIPIENT: recipient.address,
      SOLANA_RPC_URL: rpcUrl,
      MPP_SECRET_KEY: "e2e-test-secret-with-sufficient-entropy",
      MPP_REALM: "surfpool.e2e",
    });

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");

    const mppx = Mppx.create({
      methods: [solana.charge({ signer: payer, rpcUrl })],
      polyfill: false,
    });

    const response = await mppx.fetch(`http://127.0.0.1:${address.port}/api/v1/agent-report`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      product: "agent-report",
      settlement: "verified-by-solana-mpp",
    });

    const receipt = Receipt.fromResponse(response);
    expect(receipt).toMatchObject({ method: "solana", status: "success" });
    expect(receipt.reference).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);

    const transaction = await waitForTransaction(rpcUrl, receipt.reference);
    expect(transaction.meta?.err ?? null).toBeNull();

    const recipientBalanceAfter = await waitForBalanceAtLeast(
      rpcUrl,
      recipient.address,
      recipientBalanceBefore + paymentAmountLamports,
    );
    expect(recipientBalanceAfter - recipientBalanceBefore).toBe(paymentAmountLamports);
  }, 120_000);
});

async function assertRpcReady(url: string) {
  await rpc<string>(url, "getHealth");
}

async function requestAirdrop(url: string, recipient: string, lamports: bigint) {
  await rpc<string>(url, "requestAirdrop", [recipient, Number(lamports)]);
}

async function getBalance(url: string, address: string): Promise<bigint> {
  const result = await rpc<{ value: number }>(url, "getBalance", [address, { commitment: "confirmed" }]);
  return BigInt(result.value);
}

async function waitForBalanceAtLeast(url: string, address: string, expected: bigint): Promise<bigint> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const balance = await getBalance(url, address);
    if (balance >= expected) return balance;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${address} balance to reach ${expected}`);
}

async function waitForTransaction(url: string, signature: string): Promise<{ meta?: { err?: unknown } | null }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const result = await rpc<{ meta?: { err?: unknown } | null } | null>(url, "getTransaction", [
      signature,
      { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    if (result) return result;
    await delay(500);
  }
  throw new Error(`Timed out waiting for transaction ${signature}`);
}

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response.ok) {
    throw new Error(`${method} HTTP ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}`);
  return body.result as T;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
