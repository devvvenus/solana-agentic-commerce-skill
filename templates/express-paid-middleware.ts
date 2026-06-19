import type { NextFunction, Request, Response } from "express";

type PaidRouteOptions = {
  productId: string;
  amountUsd: string;
  token: "USDC";
  recipient: string;
  network: "sandbox" | "devnet" | "mainnet-beta";
  verifyPayment: PaymentVerifier;
};

type PaymentIntent = Omit<PaidRouteOptions, "verifyPayment"> & {
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

type PaymentVerifier = (paymentProof: string, intent: PaymentIntent) => Promise<PaymentReceipt>;

export function requireSolanaPayment(options: PaidRouteOptions) {
  return async function paidRoute(req: Request, res: Response, next: NextFunction) {
    const intent: PaymentIntent = {
      method: req.method,
      path: req.path,
      productId: options.productId,
      amountUsd: options.amountUsd,
      token: options.token,
      recipient: options.recipient,
      network: options.network,
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };

    const paymentProof = req.header("x-payment");
    if (!paymentProof) {
      res.status(402).json({ error: "payment_required", intent });
      return;
    }

    try {
      res.locals.paymentReceipt = await options.verifyPayment(paymentProof, intent);
      next();
    } catch (error) {
      res.status(402).json({
        error: "payment_invalid",
        reason: error instanceof Error ? error.message : "verification_failed",
        intent,
      });
    }
  };
}
