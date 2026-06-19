import { solana } from "@solana/mpp/server";
import { Mppx } from "mppx/express";

type PaidRouteOptions = {
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

export function requireSolanaPayment(options: PaidRouteOptions) {
  requirePositiveBaseUnits(options.amountBaseUnits);
  requireTokenDecimals(options.decimals);

  const mppx = Mppx.create({
    secretKey: options.secretKey,
    realm: options.realm,
    methods: [
      solana.charge({
        recipient: options.recipient,
        currency: options.currencyMint,
        decimals: options.decimals,
        network: options.network,
        rpcUrl: options.rpcUrl,
      }),
    ],
  });

  return mppx.charge({
    amount: options.amountBaseUnits,
    description: options.description,
  });
}

function requirePositiveBaseUnits(value: string) {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error("amountBaseUnits must be a positive integer");
  }
}

function requireTokenDecimals(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 18) {
    throw new Error("decimals must be an integer from 0 through 18");
  }
}
