import { solana } from "@solana/mpp/server";
import { Mppx } from "mppx/express";
import type { PaymentContract } from "./payment-contract.js";

export function createPaymentMiddleware(contract: PaymentContract) {
  const mppx = Mppx.create({
    secretKey: contract.secretKey,
    realm: contract.realm,
    methods: [
      solana.charge({
        recipient: contract.recipient,
        currency: contract.currencyMint,
        decimals: contract.decimals,
        network: contract.network,
        rpcUrl: contract.rpcUrl,
      }),
    ],
  });

  return mppx.charge({
    amount: contract.amountBaseUnits,
    description: contract.description,
  });
}
