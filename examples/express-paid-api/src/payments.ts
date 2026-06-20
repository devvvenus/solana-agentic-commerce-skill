import { solana } from "@solana/mpp/server";
import type { Store } from "mppx";
import { Mppx } from "mppx/express";
import { createMemoryCommerceStore } from "./commerce-store.js";
import type { PaymentContract } from "./payment-contract.js";

export const sharedReplayStore: Store.AtomicStore = createMemoryCommerceStore();

export function createPaymentMiddleware(
  contract: PaymentContract,
  store: Store.AtomicStore = sharedReplayStore,
) {
  const mppx = Mppx.create({
    secretKey: contract.secretKey,
    realm: contract.realm,
    methods: [
      solana.charge({
        recipient: contract.recipient,
        currency: contract.currency,
        decimals: contract.decimals,
        network: contract.network,
        rpcUrl: contract.rpcUrl,
        splits: contract.splits,
        store,
      }),
    ],
  });

  return mppx.charge({
    amount: contract.amountBaseUnits,
    description: contract.description,
  });
}
