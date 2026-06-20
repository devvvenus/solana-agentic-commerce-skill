import { address } from "@solana/kit";
import { solana } from "@solana/mpp/server";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { Receipt } from "mppx";
import { Mppx } from "mppx/server";
import type { Store } from "mppx";

import {
  CommerceError,
  paymentTermsSplitDigest,
  readCommerceCatalog,
  type CommerceCatalog,
  type PaymentTerms,
} from "./catalog.js";
import {
  createCommerceService,
  createVerifiedPaymentFromVerification,
  type PreparedRenewal,
  type PreparedSessionSettlement,
} from "./commerce-service.js";
import {
  createMemoryCommerceStore,
  type AtomicCommerceStore,
} from "./commerce-store.js";
import {
  readPaymentContract,
  validatePaymentContract,
  type PaymentContract,
} from "./payment-contract.js";
import {
  createRpcBalanceReader,
  type RpcBalanceReader,
} from "./rpc.js";

type PaymentAcceptance = {
  receiptReference: string;
  verifiedAt: string;
};

type PaidOperation = {
  operationId: string;
  externalId: string;
  expiresAt?: string;
};

type PaidGate = (
  contract: PaymentContract,
  operation: PaidOperation,
) => RequestHandler;

export type ServerDependencies = {
  commerceStore?: AtomicCommerceStore;
  paymentStore?: AtomicCommerceStore | Store.AtomicStore;
  rpc?: RpcBalanceReader;
  paidGate?: PaidGate;
  now?: () => Date;
  generateSessionId?: () => string;
};

declare global {
  namespace Express {
    interface Request {
      paymentAcceptance?: PaymentAcceptance;
    }
  }
}

export function createServer(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ServerDependencies = {},
) {
  const baseContract = withExternalId(readPaymentContract(env), "agent-report", "route:agent-report");
  const commerceStore = dependencies.commerceStore ?? createMemoryCommerceStore();
  const paymentStore = dependencies.paymentStore ?? commerceStore;
  const rpc = dependencies.rpc ?? createRpcBalanceReader(requiredEnv(env, "SOLANA_RPC_URL"));
  const paidGate = dependencies.paidGate ?? createMppPaidGate(paymentStore);
  let commerceContext: ReturnType<typeof createCommerceContext> | undefined;

  const app = express();
  app.use(express.json());

  app.get(
    "/api/v1/agent-report",
    setPaidOperation(baseContract, { operationId: "agent-report", externalId: "route:agent-report" }),
    requirePayment(paidGate),
    (_req, res) => {
      res.json({
        ok: true,
        product: "agent-report",
        settlement: "verified-by-solana-mpp",
      });
    },
  );

  app.post(
    "/api/v1/tools/wallet-analysis",
    asyncRoute(async (req, res, next) => {
      const walletAddress = parseSolanaAddress(jsonBody(req).address, "address");
      const externalId = `wallet-analysis:${walletAddress}`;
      res.locals.walletAddress = walletAddress;
      setPaidLocals(res, withExternalId(baseContract, "Wallet analysis", externalId), {
        operationId: externalId,
        externalId,
      });
      next();
    }),
    requirePayment(paidGate),
    asyncRoute(async (req, res) => {
      const walletAddress = stringLocal(res, "walletAddress");
      const balance = await rpc.getBalance(walletAddress);
      res.json({
        ok: true,
        address: walletAddress,
        balanceLamports: balance.toString(),
      });
    }),
  );

  app.get(
    "/api/v1/premium/:productId",
    asyncRoute(async (req, res, next) => {
      const productId = routeParam(req, "productId");
      const catalog = getCommerceContext().catalog;
      const product = catalog.premiumProducts.get(productId);
      if (!product) throw new CommerceError("NOT_FOUND", "Premium product not found");
      const externalId = `premium:${productId}`;
      setPaidLocals(res, contractFromTerms(baseContract, product.paymentTerms, externalId), {
        operationId: externalId,
        externalId,
      });
      res.locals.productId = productId;
      next();
    }),
    requirePayment(paidGate),
    (_req, res) => {
      res.json({ ok: true, productId: stringLocal(res, "productId"), access: "granted" });
    },
  );

  app.post(
    "/api/v1/marketplace/:productId/purchase",
    asyncRoute(async (req, res, next) => {
      const productId = routeParam(req, "productId");
      const idempotencyKey = idempotency(req);
      const catalog = getCommerceContext().catalog;
      const product = catalog.marketplaceProducts.get(productId);
      if (!product) throw new CommerceError("NOT_FOUND", "Marketplace product not found");
      const externalId = `marketplace:${productId}:purchase:${idempotencyKey}`;
      setPaidLocals(res, contractFromTerms(baseContract, product.paymentTerms, externalId), {
        operationId: idempotencyKey,
        externalId,
      });
      res.locals.productId = productId;
      res.locals.idempotencyKey = idempotencyKey;
      next();
    }),
    requirePayment(paidGate),
    (_req, res) => {
      res.json({
        ok: true,
        productId: stringLocal(res, "productId"),
        purchaseId: stringLocal(res, "idempotencyKey"),
      });
    },
  );

  app.post(
    "/api/v1/sessions",
    asyncRoute(async (req, res) => {
      const body = jsonBody(req);
      const session = await getCommerceContext().service.createSession({
        accountId: nonEmptyString(body.accountId, "accountId"),
        planId: nonEmptyString(body.planId, "planId"),
      });
      res.status(201).json(session);
    }),
  );

  app.get(
    "/api/v1/sessions/:sessionId",
    asyncRoute(async (req, res) => {
      const session = await getCommerceContext().service.getSession(routeParam(req, "sessionId"));
      if (!session) throw new CommerceError("NOT_FOUND", "Session not found");
      res.json(session);
    }),
  );

  app.post(
    "/api/v1/sessions/:sessionId/settlements",
    asyncRoute(async (req, res, next) => {
      const body = jsonBody(req);
      const idempotencyKey = nonEmptyString(body.idempotencyKey, "idempotencyKey");
      const prepared = await getCommerceContext().service.prepareSessionSettlement({
        sessionId: routeParam(req, "sessionId"),
        units: positiveSafeInteger(body.units, "units"),
        idempotencyKey,
      });
      res.locals.preparedSettlement = prepared;
      setPaidLocals(
        res,
        contractFromTerms(baseContract, prepared.paymentTerms, prepared.externalId),
        {
          operationId: prepared.operationId,
          externalId: prepared.externalId,
          expiresAt: prepared.paymentTerms.expiresAt,
        },
      );
      next();
    }),
    requirePayment(paidGate),
    asyncRoute(async (req, res) => {
      const prepared = preparedSettlement(res);
      const settlement = await getCommerceContext().service.completeSessionSettlement({
        sessionId: prepared.sessionId,
        idempotencyKey: prepared.operationId,
        verifiedPayment: verifiedPayment(req, res),
      });
      res.json({ ok: true, settlement });
    }),
  );

  app.post(
    "/api/v1/subscriptions/renewals",
    asyncRoute(async (req, res, next) => {
      const body = jsonBody(req);
      const prepared = await getCommerceContext().service.prepareRenewal({
        accountId: nonEmptyString(body.accountId, "accountId"),
        planId: nonEmptyString(body.planId, "planId"),
        period: nonEmptyString(body.period, "period"),
        idempotencyKey: nonEmptyString(body.idempotencyKey, "idempotencyKey"),
      });
      res.locals.preparedRenewal = prepared;
      setPaidLocals(
        res,
        contractFromTerms(baseContract, prepared.paymentTerms, prepared.externalId),
        {
          operationId: prepared.operationId,
          externalId: prepared.externalId,
          expiresAt: prepared.paymentTerms.expiresAt,
        },
      );
      next();
    }),
    requirePayment(paidGate),
    asyncRoute(async (req, res) => {
      const prepared = preparedRenewal(res);
      const renewal = await getCommerceContext().service.completeRenewal({
        accountId: prepared.accountId,
        planId: prepared.planId,
        period: prepared.period,
        idempotencyKey: prepared.operationId,
        verifiedPayment: verifiedPayment(req, res),
      });
      res.json({ ok: true, renewal });
    }),
  );

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendError(res, error);
  });

  return app;

  function getCommerceContext() {
    commerceContext ??= createCommerceContext(env, commerceStore, dependencies);
    return commerceContext;
  }
}

function createCommerceContext(
  env: NodeJS.ProcessEnv,
  store: AtomicCommerceStore,
  dependencies: ServerDependencies,
) {
  const catalog = readCommerceCatalog(env);
  const service = createCommerceService({
    catalog,
    store,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.generateSessionId ? { generateSessionId: dependencies.generateSessionId } : {}),
  });
  return { catalog, service };
}

function createMppPaidGate(store: AtomicCommerceStore | Store.AtomicStore): PaidGate {
  return (contract, operation) => {
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
    const handler = mppx.charge({
      amount: contract.amountBaseUnits,
      currency: contract.currency,
      description: contract.description,
      externalId: operation.externalId,
      ...(operation.expiresAt ? { expires: operation.expiresAt } : {}),
    });

    return async (req, res, next) => {
      const request = new Request(`${req.protocol}://${req.hostname}${req.originalUrl}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
      });
      const result = await handler(request);

      if (result.status === 402) {
        const challenge = result.challenge as globalThis.Response;
        res.status(challenge.status);
        for (const [key, value] of challenge.headers) res.setHeader(key, value);
        res.send(await challenge.text());
        return;
      }

      const receiptResponse = result.withReceipt(new globalThis.Response(null));
      for (const [key, value] of receiptResponse.headers) res.setHeader(key, value);
      const receipt = Receipt.fromResponse(receiptResponse);
      if (receipt.externalId !== undefined && receipt.externalId !== operation.externalId) {
        throw new Error("Payment receipt externalId mismatch");
      }
      req.paymentAcceptance = {
        receiptReference: receipt.reference,
        verifiedAt: receipt.timestamp,
      };
      next();
    };
  };
}

function requirePayment(paidGate: PaidGate): RequestHandler {
  return (req, res, next) => {
    const contract = res.locals.paymentContract as PaymentContract | undefined;
    const operation = res.locals.paidOperation as PaidOperation | undefined;
    if (!contract || !operation) throw new Error("Paid operation was not prepared");
    return paidGate(contract, operation)(req, res, next);
  };
}

function setPaidOperation(contract: PaymentContract, operation: PaidOperation): RequestHandler {
  return (_req, res, next) => {
    setPaidLocals(res, contract, operation);
    next();
  };
}

function setPaidLocals(res: Response, contract: PaymentContract, operation: PaidOperation): void {
  res.locals.paymentContract = contract;
  res.locals.paidOperation = operation;
}

function contractFromTerms(
  baseContract: PaymentContract,
  terms: PaymentTerms,
  externalId: string,
): PaymentContract {
  return validatePaymentContract({
    ...baseContract,
    amountBaseUnits: terms.amountBaseUnits,
    currency: terms.currency,
    ...(terms.decimals === undefined ? { decimals: undefined } : { decimals: terms.decimals }),
    description: terms.description,
    recipient: terms.recipient,
    externalId,
    ...(terms.splits === undefined ? { splits: undefined } : { splits: terms.splits }),
  });
}

function withExternalId(
  contract: PaymentContract,
  description: string,
  externalId: string,
): PaymentContract {
  return validatePaymentContract({ ...contract, description, externalId });
}

function verifiedPayment(req: Request, res: Response) {
  const acceptance = req.paymentAcceptance;
  const contract = res.locals.paymentContract as PaymentContract | undefined;
  const operation = res.locals.paidOperation as PaidOperation | undefined;
  if (!acceptance || !contract || !operation) throw new Error("Payment acceptance is missing");
  return createVerifiedPaymentFromVerification({
    operationId: operation.operationId,
    externalId: operation.externalId,
    receiptReference: acceptance.receiptReference,
    verifiedAt: acceptance.verifiedAt,
    amountBaseUnits: contract.amountBaseUnits,
    currency: contract.currency,
    recipient: contract.recipient,
    splitDigest: paymentTermsSplitDigest(contract),
  });
}

function preparedSettlement(res: Response): PreparedSessionSettlement {
  const prepared = res.locals.preparedSettlement as PreparedSessionSettlement | undefined;
  if (!prepared) throw new Error("Prepared settlement is missing");
  return prepared;
}

function preparedRenewal(res: Response): PreparedRenewal {
  const prepared = res.locals.preparedRenewal as PreparedRenewal | undefined;
  if (!prepared) throw new Error("Prepared renewal is missing");
  return prepared;
}

function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function jsonBody(req: Request): Record<string, unknown> {
  if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new CommerceError("VALIDATION", "Request body must be a JSON object");
  }
  return req.body as Record<string, unknown>;
}

function routeParam(req: Request, name: string): string {
  return nonEmptyString(req.params[name], name);
}

function idempotency(req: Request): string {
  const header = req.header("idempotency-key");
  if (header) return nonEmptyString(header, "idempotencyKey");
  return nonEmptyString(jsonBody(req).idempotencyKey, "idempotencyKey");
}

function parseSolanaAddress(value: unknown, field: string): string {
  const parsed = nonEmptyString(value, field);
  try {
    address(parsed);
  } catch (cause) {
    throw new CommerceError("VALIDATION", `${field} must be a valid Solana address`, { cause });
  }
  return parsed;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CommerceError("VALIDATION", `${field} must be a non-empty string`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new CommerceError("VALIDATION", `${field} must be a positive safe integer`);
  }
  return value;
}

function stringLocal(res: Response, name: string): string {
  const value = res.locals[name];
  if (typeof value !== "string") throw new Error(`Response local ${name} is missing`);
  return value;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof CommerceError) {
    res.status(statusForCommerceError(error)).json({
      ok: false,
      code: error.code,
      message: error.message,
    });
    return;
  }
  const message = error instanceof Error ? error.message : "Internal server error";
  res.status(500).json({ ok: false, code: "INTERNAL", message });
}

function statusForCommerceError(error: CommerceError): number {
  if (error.code === "VALIDATION") return 400;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "CONFLICT") return 409;
  if (error.code === "CAPACITY_EXCEEDED") return 409;
  if (error.code === "EXPIRED") return 409;
  if (error.code === "CLOSED") return 409;
  if (error.code === "RECEIPT_MISMATCH") return 409;
  if (error.code === "RECEIPT_ALREADY_CLAIMED") return 409;
  return 500;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`Paid API listening on http://127.0.0.1:${port}`);
  });
}
