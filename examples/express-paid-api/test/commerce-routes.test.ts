import type { Server } from "node:http";
import type { RequestHandler } from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryCommerceStore } from "../src/commerce-store.js";
import type { PaymentContract } from "../src/payment-contract.js";
import { createServer } from "../src/server.js";

const seller = "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY";
const platform = "BPFLoaderUpgradeab1e11111111111111111111111";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const secret = "commerce-route-test-secret-with-sufficient-entropy";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
});

describe("commerce paid routes", () => {
  it.each([
    ["report", "GET", "/api/v1/agent-report", undefined],
    ["wallet tool", "POST", "/api/v1/tools/wallet-analysis", { address: seller }],
    ["premium product", "GET", "/api/v1/premium/premium-report", undefined],
    ["marketplace", "POST", "/api/v1/marketplace/marketplace-dataset/purchase", { idempotencyKey: "purchase-1" }],
    ["session settlement", "POST", "/api/v1/sessions/session-1/settlements", { units: 2, idempotencyKey: "usage-1" }],
    ["renewal", "POST", "/api/v1/subscriptions/renewals", { accountId: "acct", planId: "monthly-api", period: "2028-02", idempotencyKey: "renew-1" }],
  ])("returns 402 before protected work for %s", async (_label, method, path, body) => {
    const gate = recordingChallengeGate();
    const rpc = untouchedBalanceReader();
    const client = await startApp({ gate: gate.handler, rpc });
    if (path.includes("/sessions/session-1/")) {
      await client.post("/api/v1/sessions", { accountId: "acct", planId: "metered-api" });
    }

    const response = method === "GET"
      ? await client.get(path)
      : await client.post(path, body);

    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toContain("Payment");
    expect(gate.contracts).toHaveLength(1);
    expect(rpc.calls).toEqual([]);
  });

  it.each([
    ["wallet address", "POST", "/api/v1/tools/wallet-analysis", { address: "bad-address" }, 400],
    ["premium product id", "GET", "/api/v1/premium/missing-product", undefined, 404],
    ["marketplace product id", "POST", "/api/v1/marketplace/missing-product/purchase", { idempotencyKey: "purchase-1" }, 404],
    ["marketplace idempotency", "POST", "/api/v1/marketplace/marketplace-dataset/purchase", {}, 400],
    ["settlement units", "POST", "/api/v1/sessions/session-1/settlements", { units: 0, idempotencyKey: "usage-1" }, 400],
    ["settlement idempotency", "POST", "/api/v1/sessions/session-1/settlements", { units: 1 }, 400],
    ["renewal period", "POST", "/api/v1/subscriptions/renewals", { accountId: "acct", planId: "monthly-api", period: "2028-2", idempotencyKey: "renew-1" }, 400],
    ["renewal idempotency", "POST", "/api/v1/subscriptions/renewals", { accountId: "acct", planId: "monthly-api", period: "2028-02" }, 400],
  ])("rejects invalid %s before the paid gate", async (_label, method, path, body, status) => {
    const gate = recordingChallengeGate();
    const rpc = untouchedBalanceReader();
    const client = await startApp({ gate: gate.handler, rpc });
    if (path.includes("/sessions/session-1/")) {
      await client.post("/api/v1/sessions", { accountId: "acct", planId: "metered-api" });
    }

    const response = method === "GET"
      ? await client.get(path)
      : await client.post(path, body);

    expect(response.status).toBe(status);
    expect(gate.contracts).toEqual([]);
    expect(rpc.calls).toEqual([]);
  });

  it("calls the wallet balance reader only after accepted payment", async () => {
    const gate = acceptingGate();
    const rpc = balanceReader("4242");
    const client = await startApp({ gate, rpc });

    const response = await client.post("/api/v1/tools/wallet-analysis", { address: seller });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, address: seller, balanceLamports: "4242" });
    expect(rpc.calls).toEqual([seller]);
  });

  it("completes metered settlement only after accepted payment", async () => {
    const client = await startApp({ gate: acceptingGate(), rpc: untouchedBalanceReader() });
    const session = await (await client.post("/api/v1/sessions", { accountId: "acct", planId: "metered-api" })).json();

    const response = await client.post(`/api/v1/sessions/${session.sessionId}/settlements`, {
      units: 3,
      idempotencyKey: "usage-3",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settlement).toMatchObject({ status: "settled", units: "3" });
    expect((await (await client.get(`/api/v1/sessions/${session.sessionId}`)).json()).usedUnits).toBe("3");
  });

  it("activates renewal only after accepted payment", async () => {
    const client = await startApp({ gate: acceptingGate(), rpc: untouchedBalanceReader() });

    const response = await client.post("/api/v1/subscriptions/renewals", {
      accountId: "acct",
      planId: "monthly-api",
      period: "2028-02",
      idempotencyKey: "renew-1",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.renewal).toMatchObject({ status: "active", accountId: "acct", period: "2028-02" });
  });
});

function recordingChallengeGate() {
  const contracts: PaymentContract[] = [];
  const handler = ((contract: PaymentContract) => {
    contracts.push(contract);
    const routeGate: RequestHandler = (_req, res) => {
      res.status(402).setHeader("www-authenticate", "Payment test-route");
      res.send("payment required");
    };
    return routeGate;
  }) as never;
  return { contracts, handler };
}

function acceptingGate() {
  return ((_contract: PaymentContract, operation: { externalId: string }) => {
    const handler: RequestHandler = (req, _res, next) => {
      Object.assign(req, {
        paymentAcceptance: {
          receiptReference: `receipt:${operation.externalId}`,
          verifiedAt: "2028-02-29T12:00:30.000Z",
        },
      });
      next();
    };
    return handler;
  }) as never;
}

function balanceReader(value: string) {
  const calls: string[] = [];
  return {
    calls,
    async getBalance(address: string) {
      calls.push(address);
      return BigInt(value);
    },
  };
}

function untouchedBalanceReader() {
  const calls: string[] = [];
  return {
    calls,
    async getBalance(address: string) {
      calls.push(address);
      throw new Error("balance reader was called before payment");
    },
  };
}

async function startApp(options: { gate: never; rpc: ReturnType<typeof balanceReader> | ReturnType<typeof untouchedBalanceReader> }) {
  const app = createServer(testEnv(), {
    commerceStore: createMemoryCommerceStore(),
    paymentStore: createMemoryCommerceStore(),
    paidGate: options.gate,
    rpc: options.rpc,
    now: () => new Date("2028-02-29T12:00:00.000Z"),
    generateSessionId: () => "session-1",
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    get: (path: string) => fetch(`${baseUrl}${path}`),
    post: (path: string, body?: unknown) => fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  };
}

function testEnv(): NodeJS.ProcessEnv {
  return {
    PAID_ROUTE_AMOUNT_BASE_UNITS: "1000",
    PAID_ROUTE_CURRENCY_MINT: mint,
    PAID_ROUTE_DECIMALS: "6",
    PAID_ROUTE_DESCRIPTION: "Agent report",
    SOLANA_PAYMENT_NETWORK: "devnet",
    SOLANA_PAYMENT_RECIPIENT: seller,
    SOLANA_RPC_URL: "http://127.0.0.1:1",
    MPP_SECRET_KEY: secret,
    MPP_REALM: "commerce.routes.test",
    COMMERCE_CATALOG_JSON: JSON.stringify({
      payment: {
        currency: mint,
        decimals: 6,
        network: "devnet",
        rpcUrl: "http://127.0.0.1:1",
        secretKey: secret,
        realm: "commerce.routes.test",
      },
      premiumProducts: [{
        id: "premium-report",
        amountBaseUnits: "2500000",
        description: "Premium research report",
        recipient: seller,
      }],
      marketplaceProducts: [{
        id: "marketplace-dataset",
        amountBaseUnits: "10000000",
        description: "Marketplace dataset",
        recipient: seller,
        splits: [{ recipient: platform, amount: "1000000", memo: "Platform" }],
      }],
      meteredPlans: [{
        id: "metered-api",
        unitPriceBaseUnits: "1000",
        maxUnits: 10,
        sessionTtlSeconds: 3600,
        paymentExpirySeconds: 60,
        description: "Metered API usage",
        recipient: seller,
      }],
      subscriptionPlans: [{
        id: "monthly-api",
        priceBaseUnits: "12000000",
        periodDurationMonths: 1,
        paymentExpirySeconds: 300,
        description: "Monthly API access",
        recipient: seller,
      }],
    }),
  };
}
