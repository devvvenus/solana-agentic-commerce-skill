import { describe, expect, it } from "vitest";
import {
  type PaymentContract,
  readPaymentContract,
  validatePaymentContract,
} from "../src/payment-contract.js";

const validContract: PaymentContract = {
  amountBaseUnits: "1000",
  currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
  description: "Paid agentic commerce endpoint",
  recipient: "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
  network: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
  secretKey: "unit-test-secret-with-sufficient-entropy",
  realm: "Test Realm",
};

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

describe("validatePaymentContract", () => {
  it("accepts complete contracts with splits and commerce metadata", () => {
    const contract: PaymentContract = {
      ...validContract,
      externalId: "order-123",
      expiresInSeconds: 300,
      splits: [
        {
          recipient: "BPFLoaderUpgradeab1e11111111111111111111111",
          amount: "250",
          memo: "Partner share",
          ataCreationRequired: true,
        },
      ],
    };

    expect(validatePaymentContract(contract)).toBe(contract);
  });

  it("rejects an invalid primary recipient address", () => {
    expect(() =>
      validatePaymentContract({ ...validContract, recipient: "invalid-address" }),
    ).toThrow();
  });

  it("rejects a malformed SPL mint address", () => {
    expect(() =>
      validatePaymentContract({ ...validContract, currency: "invalid-mint" }),
    ).toThrow();
  });

  it("rejects an invalid split recipient address", () => {
    expect(() =>
      validatePaymentContract({
        ...validContract,
        splits: [{ recipient: "invalid-address", amount: "1" }],
      }),
    ).toThrow();
  });

  it("rejects secrets shorter than 32 characters", () => {
    expect(() =>
      validatePaymentContract({ ...validContract, secretKey: "too-short" }),
    ).toThrow("at least 32 characters");
  });

  it("rejects zero-value splits", () => {
    expect(() =>
      validatePaymentContract({
        ...validContract,
        splits: [
          {
            recipient: "BPFLoaderUpgradeab1e11111111111111111111111",
            amount: "0",
          },
        ],
      }),
    ).toThrow("positive integer");
  });

  it("rejects a split total equal to the charge amount", () => {
    expect(() =>
      validatePaymentContract({
        ...validContract,
        splits: [
          {
            recipient: "BPFLoaderUpgradeab1e11111111111111111111111",
            amount: "1000",
          },
        ],
      }),
    ).toThrow("less than the charge amount");
  });

  it("rejects a split total greater than the charge amount", () => {
    expect(() =>
      validatePaymentContract({
        ...validContract,
        splits: [
          {
            recipient: "BPFLoaderUpgradeab1e11111111111111111111111",
            amount: "1001",
          },
        ],
      }),
    ).toThrow("less than the charge amount");
  });

  it("rejects individually valid splits whose aggregate equals a large charge", () => {
    const amountBaseUnits = "36028797018963970";
    const splitAmount = "18014398509481985";

    expect(() =>
      validatePaymentContract({
        ...validContract,
        amountBaseUnits,
        splits: [
          {
            recipient: "BPFLoaderUpgradeab1e11111111111111111111111",
            amount: splitAmount,
          },
          {
            recipient: "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
            amount: splitAmount,
          },
        ],
      }),
    ).toThrow("less than the charge amount");
  });

  it("rejects individually valid splits whose aggregate exceeds a large charge", () => {
    const amountBaseUnits = "36028797018963969";
    const splitAmount = "18014398509481985";

    expect(() =>
      validatePaymentContract({
        ...validContract,
        amountBaseUnits,
        splits: [
          {
            recipient: "BPFLoaderUpgradeab1e11111111111111111111111",
            amount: splitAmount,
          },
          {
            recipient: "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
            amount: splitAmount,
          },
        ],
      }),
    ).toThrow("less than the charge amount");
  });

  it("accepts a large split total exactly one base unit below the charge", () => {
    const amountBaseUnits = "18014398509481985";
    const splitAmounts = ["9007199254740992", "9007199254740992"];
    const contract: PaymentContract = {
      ...validContract,
      amountBaseUnits,
      splits: [
        {
          recipient: "BPFLoaderUpgradeab1e11111111111111111111111",
          amount: splitAmounts[0],
        },
        {
          recipient: "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
          amount: splitAmounts[1],
        },
      ],
    };

    const exactSplitTotal = splitAmounts.reduce(
      (total, amount) => total + BigInt(amount),
      0n,
    );
    const roundedSplitTotal = splitAmounts.reduce(
      (total, amount) => total + Number(amount),
      0,
    );

    expect(exactSplitTotal).toBe(BigInt(amountBaseUnits) - 1n);
    expect(roundedSplitTotal).toBe(Number(amountBaseUnits));
    expect(validatePaymentContract(contract)).toBe(contract);
  });

  it("rejects more than eight splits", () => {
    expect(() =>
      validatePaymentContract({
        ...validContract,
        amountBaseUnits: "10000",
        splits: Array.from({ length: 9 }, () => ({
          recipient: "BPFLoaderUpgradeab1e11111111111111111111111",
          amount: "1",
        })),
      }),
    ).toThrow("at most 8 splits");
  });

  it.each([-1, 1.5, 19, undefined])(
    "rejects invalid SPL decimals: %s",
    (decimals) => {
      expect(() =>
        validatePaymentContract({ ...validContract, decimals }),
      ).toThrow("integer from 0 through 18");
    },
  );

  it("rejects unsupported networks", () => {
    expect(() =>
      validatePaymentContract({
        ...validContract,
        network: "testnet" as PaymentContract["network"],
      }),
    ).toThrow("localnet, devnet, or mainnet-beta");
  });
});
