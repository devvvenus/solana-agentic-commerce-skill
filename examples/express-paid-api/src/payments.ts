import { solana } from "@solana/mpp/server";
import type { Store } from "mppx";
import { Mppx } from "mppx/express";
import {
  type AtomicCommerceStore,
  createMemoryCommerceStore,
} from "./commerce-store.js";
import type { PaymentContract } from "./payment-contract.js";

export const sharedReplayStore = createMemoryCommerceStore() as Store.AtomicStore;

export function createPaymentMiddleware(
  contract: PaymentContract,
  store: AtomicCommerceStore | Store.AtomicStore = sharedReplayStore,
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
        store: store as Store.AtomicStore,
      }),
    ],
  });

  return mppx.charge({
    amount: contract.amountBaseUnits,
    description: contract.description,
  });
}
