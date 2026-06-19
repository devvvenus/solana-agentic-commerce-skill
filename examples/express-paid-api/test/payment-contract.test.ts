import { describe, expect, it } from "vitest";
import { readPaymentContract } from "../src/payment-contract.js";

describe("readPaymentContract", () => {
  it("requires server-side recipient, RPC URL, amount, currency, and MPP secret", () => {
    expect(() => readPaymentContract({})).toThrow("PAID_ROUTE_AMOUNT_BASE_UNITS");
  });

  it("builds a server-controlled payment contract", () => {
    const contract = readPaymentContract({
      PAID_ROUTE_AMOUNT_BASE_UNITS: "1000",
      PAID_ROUTE_CURRENCY_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      PAID_ROUTE_DECIMALS: "6",
      SOLANA_PAYMENT_RECIPIENT: "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
      SOLANA_RPC_URL: "https://402.surfnet.dev:8899",
      MPP_SECRET_KEY: "unit-test-secret-with-sufficient-entropy",
      MPP_REALM: "Test Realm",
    });

    expect(contract).toMatchObject({
      amountBaseUnits: "1000",
      currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
      network: "localnet",
      realm: "Test Realm",
    });
  });

  it("supports native SOL charges without token decimals", () => {
    const contract = readPaymentContract({
      PAID_ROUTE_AMOUNT_BASE_UNITS: "25000",
      PAID_ROUTE_CURRENCY: "sol",
      SOLANA_PAYMENT_RECIPIENT: "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
      SOLANA_RPC_URL: "http://127.0.0.1:8899",
      MPP_SECRET_KEY: "unit-test-secret-with-sufficient-entropy",
    });

    expect(contract).toMatchObject({
      amountBaseUnits: "25000",
      currency: "sol",
      decimals: undefined,
      network: "localnet",
    });
  });

  it("rejects decimal display amounts instead of silently mispricing the route", () => {
    expect(() =>
      readPaymentContract({
        PAID_ROUTE_AMOUNT_BASE_UNITS: "0.001",
        PAID_ROUTE_CURRENCY_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        PAID_ROUTE_DECIMALS: "6",
      }),
    ).toThrow("positive integer");
  });
});
