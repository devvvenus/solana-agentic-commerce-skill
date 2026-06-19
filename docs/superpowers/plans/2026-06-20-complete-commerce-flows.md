# Complete Agentic Commerce Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and prove every advertised Solana agentic-commerce flow with published MPP APIs and real Surfpool settlement while retaining devnet/mainnet configuration compatibility.

**Architecture:** Extend the Express example around one injected payment service, one atomic MPP replay store, and one application commerce store. Static and request-derived payment contracts protect six concrete routes; Surfpool E2E creates real SOL and SPL assets and verifies receipts, transactions, recipient deltas, state transitions, and adversarial rejection.

**Tech Stack:** TypeScript, Express 5, `@solana/mpp`, `mppx`, `@solana/kit`, `@solana-program/token`, `@solana-program/system`, Vitest, Surfpool, GitHub Actions.

---

## File Map

- Modify `examples/express-paid-api/src/payment-contract.ts`: canonical money, split, network, and contract validation.
- Modify `examples/express-paid-api/src/payments.ts`: shared atomic replay store and split-aware MPP middleware.
- Create `examples/express-paid-api/src/catalog.ts`: server-owned products, prices, plans, and split policy.
- Create `examples/express-paid-api/src/commerce-store.ts`: atomic fulfillment, session, and subscription state.
- Create `examples/express-paid-api/src/commerce-service.ts`: session and renewal state transitions.
- Create `examples/express-paid-api/src/rpc.ts`: live wallet balance lookup.
- Modify `examples/express-paid-api/src/server.ts`: six runnable commerce surfaces and dependency injection.
- Create `examples/express-paid-api/test/commerce-store.test.ts`: state and idempotency tests.
- Create `examples/express-paid-api/test/commerce-routes.test.ts`: unpaid, validation, and protected-work tests.
- Create `examples/express-paid-api/test/support/surfpool.ts`: RPC, transaction, mint, token-account, and balance helpers.
- Replace `examples/express-paid-api/test/onchain-payment.e2e.test.ts`: complete SOL/SPL/agent/split/session/subscription E2E suite.
- Create `examples/express-paid-api/test/payment-security.e2e.test.ts`: replay and wrong-contract attacks against Surfpool.
- Modify package scripts, CI workflow, README, skill workflows, and repository validator.

### Task 1: Validate Complete Payment Contracts

**Files:**
- Modify: `examples/express-paid-api/src/payment-contract.ts`
- Modify: `examples/express-paid-api/test/payment-contract.test.ts`

- [ ] **Step 1: Write failing split and security validation tests**

Add tests constructing contracts with `splits`, `externalId`, and `expiresInSeconds`. Assert rejection of an invalid recipient address, weak secret, zero split, split total greater than or equal to charge amount, more than eight splits, invalid decimals, and unsupported networks.

```ts
expect(() => validatePaymentContract({
  ...validContract,
  amountBaseUnits: "100",
  splits: [{ recipient: platform, amount: "100", memo: "platform" }],
})).toThrow("split total must be less than amountBaseUnits");
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `npm --prefix examples/express-paid-api test -- payment-contract.test.ts`

Expected: FAIL because `validatePaymentContract` and split fields do not exist.

- [ ] **Step 3: Implement canonical validation**

Define `PaymentSplit` and extend `PaymentContract`:

```ts
export type PaymentSplit = {
  recipient: string;
  amount: string;
  memo?: string;
  ataCreationRequired?: boolean;
};

export type PaymentContract = {
  amountBaseUnits: string;
  currency: string;
  decimals?: number;
  description: string;
  recipient: string;
  network: PaymentNetwork;
  rpcUrl: string;
  secretKey: string;
  realm: string;
  externalId?: string;
  expiresInSeconds?: number;
  splits?: PaymentSplit[];
};
```

Use `address()` from `@solana/kit` to validate all addresses. Require a secret length of at least 32 characters, positive integer base units, zero to eighteen decimals, at most eight positive splits, and split total below total amount.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm --prefix examples/express-paid-api test -- payment-contract.test.ts && npm run example:typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/express-paid-api/src/payment-contract.ts examples/express-paid-api/test/payment-contract.test.ts
git commit -m "Validate complete payment contracts"
```

### Task 2: Add Shared Payment and Commerce Stores

**Files:**
- Modify: `examples/express-paid-api/src/payments.ts`
- Create: `examples/express-paid-api/src/commerce-store.ts`
- Create: `examples/express-paid-api/test/commerce-store.test.ts`

- [ ] **Step 1: Write failing atomic-state tests**

Cover session creation, positive incremental settlement, maximum-unit enforcement, expiry, completed idempotency replay, conflicting idempotency input, subscription activation, and duplicate billing-period rejection.

```ts
const first = await store.update("settlement:idem-1", current =>
  current ? { op: "noop", result: current } : { op: "set", value: fulfillment, result: fulfillment },
);
const replay = await store.get("settlement:idem-1");
expect(replay).toEqual(first);
```

- [ ] **Step 2: Confirm red**

Run: `npm --prefix examples/express-paid-api test -- commerce-store.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement store boundaries**

Create an `AtomicCommerceStore` interface with `get`, `put`, and `update`. Implement `createMemoryCommerceStore()` with serialized per-key updates. Update `createPaymentMiddleware(contract, paymentStore)` to pass one shared `Store.AtomicStore` into `solana.charge({ store, splits })`.

```ts
solana.charge({
  recipient: contract.recipient,
  currency: contract.currency,
  decimals: contract.decimals,
  network: contract.network,
  rpcUrl: contract.rpcUrl,
  splits: contract.splits,
  store: paymentStore,
})
```

Expose Redis/Upstash deployment examples through the SDK adapters without embedding credentials.

- [ ] **Step 4: Confirm green**

Run: `npm --prefix examples/express-paid-api test -- commerce-store.test.ts && npm run example:typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/express-paid-api/src/payments.ts examples/express-paid-api/src/commerce-store.ts examples/express-paid-api/test/commerce-store.test.ts
git commit -m "Add atomic commerce state"
```

### Task 3: Implement Server-Owned Catalog and Commerce Rules

**Files:**
- Create: `examples/express-paid-api/src/catalog.ts`
- Create: `examples/express-paid-api/src/commerce-service.ts`
- Create: `examples/express-paid-api/test/commerce-service.test.ts`

- [ ] **Step 1: Write failing catalog and state-transition tests**

Assert that clients cannot override prices or recipients, session charges equal `units * unitPrice`, overflow is rejected, subscription periods use `YYYY-MM`, and idempotency keys are scoped to customer and operation.

- [ ] **Step 2: Confirm red**

Run: `npm --prefix examples/express-paid-api test -- commerce-service.test.ts`

Expected: FAIL because catalog and service functions do not exist.

- [ ] **Step 3: Implement minimal server-owned rules**

Define one premium content product, one marketplace product, one metered plan, and one subscription plan from validated environment configuration. Implement `prepareSessionSettlement`, `completeSessionSettlement`, `prepareRenewal`, and `completeRenewal` as atomic state transitions.

```ts
const amountBaseUnits = (BigInt(units) * BigInt(plan.unitPriceBaseUnits)).toString();
const operationKey = `session:${session.id}:settlement:${idempotencyKey}`;
```

- [ ] **Step 4: Confirm green**

Run: `npm --prefix examples/express-paid-api test -- commerce-service.test.ts && npm run example:typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/express-paid-api/src/catalog.ts examples/express-paid-api/src/commerce-service.ts examples/express-paid-api/test/commerce-service.test.ts
git commit -m "Implement commerce accounting rules"
```

### Task 4: Add Six Runnable Paid Routes

**Files:**
- Create: `examples/express-paid-api/src/rpc.ts`
- Modify: `examples/express-paid-api/src/server.ts`
- Create: `examples/express-paid-api/test/commerce-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Test 402 responses for the report, wallet tool, premium content, marketplace, session settlement, and renewal routes. Verify invalid addresses, products, units, periods, and missing idempotency keys fail before protected work. Inject an RPC spy that throws if called before payment and assert it remains untouched on 402 responses.

- [ ] **Step 2: Confirm red**

Run: `npm --prefix examples/express-paid-api test -- commerce-routes.test.ts`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Implement routes and dependency injection**

Change `createServer(env, dependencies)` to receive shared payment and commerce stores plus an RPC balance reader. Use server-derived `PaymentContract` objects and per-operation `externalId` values. The paid tool calls `getBalance` only after MPP verification. Dynamic session and renewal routes calculate contracts after input validation and complete state only after verified payment.

```ts
app.post("/api/v1/tools/wallet-analysis", paymentFor(toolContract), async (req, res) => {
  const balance = await dependencies.rpc.getBalance(req.body.address);
  res.json({ address: req.body.address, lamports: balance.toString(), network: config.network });
});
```

- [ ] **Step 4: Confirm green**

Run: `npm --prefix examples/express-paid-api test -- commerce-routes.test.ts && npm run example:typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/express-paid-api/src/rpc.ts examples/express-paid-api/src/server.ts examples/express-paid-api/test/commerce-routes.test.ts
git commit -m "Add runnable paid commerce routes"
```

### Task 5: Build Real Surfpool SPL Infrastructure

**Files:**
- Modify: `examples/express-paid-api/package.json`
- Modify: `examples/express-paid-api/package-lock.json`
- Create: `examples/express-paid-api/test/support/surfpool.ts`
- Modify: `examples/express-paid-api/test/onchain-payment.e2e.test.ts`

- [ ] **Step 1: Add direct Solana program dependencies**

Run: `npm --prefix examples/express-paid-api install -D @solana-program/token@0.11.0 @solana-program/system@0.12.0`

Expected: lockfile records direct development dependencies.

- [ ] **Step 2: Write a failing SPL settlement E2E**

Generate payer, mint authority, mint, seller, platform, and referrer signers. Request real Surfpool airdrops, create a six-decimal SPL mint with `getCreateMintInstructionPlan`, mint payer tokens with `getMintToATAInstructionPlanAsync`, call the premium endpoint through the real MPP client, and assert receipt plus recipient token delta.

- [ ] **Step 3: Confirm red against Surfpool**

Run: `npm run example:e2e`

Expected: FAIL because Surfpool token helpers and SPL route configuration are absent.

- [ ] **Step 4: Implement reusable Surfpool helpers**

Use `@solana/kit` transaction plans and RPC calls to create/mint tokens. Add helpers for airdrop, SOL balance, ATA derivation, token balance, transaction lookup, server lifecycle, and MPP client creation. Every success assertion must derive from RPC state or parsed `Payment-Receipt`.

- [ ] **Step 5: Add all real-flow E2E cases**

Cover native report, RPC-backed wallet tool, SPL premium content, atomic SPL marketplace split, metered settlement, and subscription renewal. For marketplace, assert seller receives `total - platform - referrer`, both splits receive exact amounts, and all deltas correspond to the receipt transaction.

- [ ] **Step 6: Confirm green**

Run: `npm run example:e2e`

Expected: all real Surfpool settlement cases PASS.

- [ ] **Step 7: Commit**

```bash
git add examples/express-paid-api/package.json examples/express-paid-api/package-lock.json examples/express-paid-api/test/support/surfpool.ts examples/express-paid-api/test/onchain-payment.e2e.test.ts
git commit -m "Prove complete commerce flows on Surfpool"
```

### Task 6: Add Adversarial Payment Tests

**Files:**
- Create: `examples/express-paid-api/test/payment-security.e2e.test.ts`
- Modify: `examples/express-paid-api/package.json`

- [ ] **Step 1: Write failing credential attack tests**

Capture the actual authorization generated by the MPP client transport. Replay it against the same route, a different route, a different amount, and a different split policy. Add conflicting idempotency, expired session, and over-limit settlement attempts. Assert protected data is withheld and state remains unchanged.

- [ ] **Step 2: Confirm red**

Run: `npm --prefix examples/express-paid-api run test:e2e -- payment-security.e2e.test.ts`

Expected: at least one test fails until shared atomic replay state and route binding are correct.

- [ ] **Step 3: Fix only demonstrated gaps**

Share one MPP atomic store across route methods, bind operation contracts to server-derived external IDs, and make commerce updates compare expected operation input before returning an existing fulfillment.

- [ ] **Step 4: Confirm green and rerun complete E2E**

Run: `npm run example:e2e`

Expected: settlement and adversarial suites PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/express-paid-api/test/payment-security.e2e.test.ts examples/express-paid-api/package.json examples/express-paid-api/src
git commit -m "Enforce payment replay and idempotency safety"
```

### Task 7: Align Documentation, Validation, and CI

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `workflows/agent-paid-tool-call.md`
- Modify: `workflows/metered-session.md`
- Modify: `references/security-checklist.md`
- Modify: `examples/express-paid-api/.env.example`
- Modify: `scripts/validate-repo.ps1`
- Modify: `.github/workflows/verify.yml`

- [ ] **Step 1: Extend repository validation first**

Require every new implementation and test file plus README capability-matrix terms. Run `npm run validate` and confirm it fails before documentation updates.

- [ ] **Step 2: Document only proven behavior**

Add a capability matrix with endpoint, asset, implementation file, and test evidence. Explain Surfpool proof, devnet/mainnet variables, persistent Redis/Upstash replay storage, atomic split semantics, app-managed incremental settlement, and explicit renewal behavior.

- [ ] **Step 3: Expand CI E2E command**

Keep Surfpool pinned and run both settlement and adversarial suites. Update deprecated action majors only after checking official action release documentation.

- [ ] **Step 4: Run full local verification**

Run:

```bash
npm run verify
npm run example:e2e
git diff --check
git status --short
```

Expected: validation, typecheck, integration tests, dependency audit, all real Surfpool tests, and whitespace checks PASS; only intended files are modified.

- [ ] **Step 5: Commit**

```bash
git add README.md SKILL.md workflows references examples/express-paid-api/.env.example scripts/validate-repo.ps1 .github/workflows/verify.yml
git commit -m "Document verified commerce capabilities"
```

### Task 8: Security Audit, Publish, and Remote Verification

**Files:**
- Review all changed files.

- [ ] **Step 1: Perform a focused security review**

Inspect private-key boundaries, server-owned prices, payment-before-work ordering, store atomicity, route binding, split arithmetic, integer conversions, RPC errors, logs, and duplicate fulfillment. Resolve every high or medium finding and rerun the affected tests.

- [ ] **Step 2: Run final verification from a clean dependency install**

Run:

```bash
npm ci --prefix examples/express-paid-api
npm run verify
npm run example:e2e
git diff --check
```

Expected: all commands PASS with zero moderate-or-higher dependency vulnerabilities.

- [ ] **Step 3: Push main and tags**

Run: `git push origin main --follow-tags`

Expected: remote `devvvenus/solana-agentic-commerce-skill` accepts all commits.

- [ ] **Step 4: Verify GitHub Actions**

Run: `gh run list --repo devvvenus/solana-agentic-commerce-skill --limit 3`, then watch the new main run with `gh run watch <run-id> --repo devvvenus/solana-agentic-commerce-skill --exit-status`.

Expected: both `verify` and `e2e` jobs complete successfully.

- [ ] **Step 5: Record repository intelligence**

Update the Obsidian evaluation note with the final commit, paths, verification commands, implemented capability matrix, and CI URL.
