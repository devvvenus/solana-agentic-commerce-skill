import express from "express";
import { readPaymentContract } from "./payment-contract.js";
import { createPaymentMiddleware } from "./payments.js";

export function createServer(env: NodeJS.ProcessEnv = process.env) {
  const contract = readPaymentContract(env);
  const app = express();
  app.use(express.json());

  app.get("/api/v1/agent-report", createPaymentMiddleware(contract), (_req, res) => {
    res.json({
      ok: true,
      product: "agent-report",
      settlement: "verified-by-solana-mpp",
    });
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`Paid API listening on http://127.0.0.1:${port}`);
  });
}
