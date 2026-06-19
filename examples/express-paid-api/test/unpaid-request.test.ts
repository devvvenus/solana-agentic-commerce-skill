import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
});

describe("paid Express route", () => {
  it("returns a real MPP 402 challenge when payment proof is absent", async () => {
    const app = createServer({
      PAID_ROUTE_AMOUNT_BASE_UNITS: "1000",
      PAID_ROUTE_CURRENCY_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      PAID_ROUTE_DECIMALS: "6",
      SOLANA_PAYMENT_NETWORK: "localnet",
      SOLANA_PAYMENT_RECIPIENT: "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
      SOLANA_RPC_URL: "http://127.0.0.1:1",
      MPP_SECRET_KEY: "integration-test-secret-with-sufficient-entropy",
      MPP_REALM: "integration.test",
    });

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/agent-report`);

    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toContain("Payment");
    expect(await response.text()).not.toContain("verified-by-solana-mpp");
  });
});
