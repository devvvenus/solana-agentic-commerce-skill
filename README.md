# Solana Agentic Commerce Skill

AI-agent skill for building Solana-paid APIs, paid agent tool calls, stablecoin paywalls, marketplace splits, metered sessions, and x402/MPP-style commerce flows with Solana Pay Kit patterns.

This submission targets the Superteam Brasil bounty: **Ship useful agent skills we can add to Solana AI Kit**.

## Why this skill

Solana AI Kit already covers broad Solana development, DeFi, infrastructure, security, mobile, games, and ecosystem skills. The missing builder workflow is agentic commerce: helping founders turn an API, dataset, AI tool call, or SaaS feature into a paid Solana service.

This is intentionally **not** a Pay Kit SDK port. It is an application-integration skill for builders using Pay Kit, x402-style single-recipient flows, and MPP-style richer payment intents.

## What it helps build

- Paid API endpoints using HTTP `402 Payment Required`
- Paid AI tool calls and agent-to-agent commerce
- Stablecoin paywalls for premium content, reports, datasets, and model/tool access
- Marketplace routes with platform fees and recipient splits
- Metered sessions and subscription-style settlement patterns
- Security reviews for payment proof, replay protection, and settlement verification

## Skill layout

```text
.
|-- SKILL.md
|-- references/
|   |-- pay-kit-overview.md
|   |-- payment-protocols.md
|   `-- security-checklist.md
|-- workflows/
|   |-- add-paywall-to-api.md
|   |-- agent-paid-tool-call.md
|   `-- metered-session.md
|-- templates/
|   |-- express-paid-middleware.ts
|   `-- nextjs-paid-route.ts
`-- commands/
    |-- paywall-plan.md
    `-- paywall-review.md
```

## Example prompts

```text
Use $solana-agentic-commerce to add a 0.10 USDC paywall to my Next.js /api/report route.
```

```text
Use $solana-agentic-commerce to design an agent-to-agent paid tool call where my research agent pays for a premium Solana wallet analysis.
```

```text
Use $solana-agentic-commerce to review this Express payment middleware for replay protection and settlement verification gaps.
```

## Install

For Codex/Claude-style skill folders, copy this folder into your agent skills directory or add it as a repository skill source.

For Solana AI Kit integration, the useful unit is the `SKILL.md`, `references/`, `workflows/`, `templates/`, and `commands/` set. The root is kept simple so it can be copied into `ext/` or a marketplace layout.

## Sources used

- Solana Pay Kit: https://github.com/solana-foundation/pay-kit
- Solana AI Kit: https://github.com/solanabr/solana-ai-kit
- SendAI Solana skills marketplace: https://github.com/sendaifun/skills
- Solana payments reference: https://github.com/solana-foundation/solana-dev-skill

## Status

Bounty submission candidate. Templates use the released `@solana/mpp/server` and `mppx/express` surfaces, require server-side payment configuration before a paid route can start, and fail closed when required payment configuration is missing.

## Judge / Reviewer Quickstart

This repository includes a runnable Pay Kit / MPP Express example and real local settlement E2E coverage. The payment tests start from generated payer and recipient keypairs, pay through `@solana/mpp/client`, parse `Payment-Receipt`, fetch the transaction by receipt reference, and verify balance deltas plus app state transitions.

```bash
npm run example:install
npm run verify
```

`npm run verify` runs repository validation, TypeScript checking, the normal example suite, and `npm audit --audit-level=moderate`. The normal example suite does not require Surfpool and currently covers 5 files / 97 tests, including 17 route tests.

For the full Surfpool local settlement E2E, start Surfpool in another terminal and run:

```bash
surfpool start --ci --offline --airdrop-amount 0
npm run example:e2e
```

`npm run example:e2e` currently covers 2 files / 14 tests when Surfpool is running: 6 settlement cases and 8 adversarial cases. The GitHub Actions workflow contains a pinned Surfpool `v1.3.1` E2E job that runs the settlement and adversarial suites against the local validator.

## Capability matrix

| Endpoint | Asset | Implementation file | Test evidence |
|---|---|---|---|
| `GET /api/v1/agent-report` | Native SOL | `examples/express-paid-api/src/server.ts`, `examples/express-paid-api/src/payment-contract.ts` | Route coverage in `commerce-routes.test.ts`; Surfpool E2E settles native SOL, parses `Payment-Receipt`, fetches the receipt transaction, and checks recipient lamport delta. |
| `POST /api/v1/tools/wallet-analysis` | Native SOL | `examples/express-paid-api/src/server.ts`, `examples/express-paid-api/src/rpc.ts` | Route coverage in `commerce-routes.test.ts`; Surfpool E2E pays before returning a live RPC balance and checks recipient lamport delta. |
| `GET /api/v1/premium/:productId` | SPL token | `examples/express-paid-api/src/server.ts`, `examples/express-paid-api/src/catalog.ts` | Route coverage in `commerce-routes.test.ts`; Surfpool E2E settles SPL premium access and checks recipient token delta. |
| `POST /api/v1/marketplace/:productId/purchase` | SPL token with seller, platform, and referrer recipients | `examples/express-paid-api/src/server.ts`, `examples/express-paid-api/src/catalog.ts` | Route coverage in `commerce-routes.test.ts`; Surfpool E2E checks exact seller, platform, and referrer token deltas from the accepted settlement. |
| `POST /api/v1/sessions` and `POST /api/v1/sessions/:sessionId/settlements` | SPL token metered settlement | `examples/express-paid-api/src/server.ts`, `examples/express-paid-api/src/commerce-service.ts`, `examples/express-paid-api/src/commerce-store.ts` | Route and service coverage in `commerce-routes.test.ts`, `commerce-service.test.ts`, and `commerce-store.test.ts`; Surfpool E2E settles usage and verifies `usedUnits` increments once. |
| `POST /api/v1/subscriptions/renewals` | SPL token renewal | `examples/express-paid-api/src/server.ts`, `examples/express-paid-api/src/commerce-service.ts`, `examples/express-paid-api/src/commerce-store.ts` | Route and service coverage in `commerce-routes.test.ts`, `commerce-service.test.ts`, and `commerce-store.test.ts`; Surfpool E2E activates the requested billing period after receipt-backed settlement. |
| Replay and settlement abuse checks | Native SOL and SPL token | `examples/express-paid-api/src/server.ts`, `examples/express-paid-api/src/commerce-service.ts`, `examples/express-paid-api/src/commerce-store.ts` | `payment-security.e2e.test.ts` covers credential capture, same-route replay rejection, wallet-tool replay rejection, different route, different amount, different split policy, idempotency conflict, and expired or over-limit settlement attempts. |

## Working example

The `examples/express-paid-api` app is the runnable reference path for this skill. The verified server uses `@solana/mpp/server` with `mppx/server` so it can capture `Payment-Receipt` before completing app state transitions:

```ts
import { solana } from "@solana/mpp/server";
import { Mppx } from "mppx/server";
```

Run locally after installing dependencies:

```bash
npm --prefix examples/express-paid-api install
npm --prefix examples/express-paid-api run typecheck
npm --prefix examples/express-paid-api test
```

Run the full local settlement E2E with Surfpool running on `127.0.0.1:8899`:

```bash
surfpool start --ci --offline --airdrop-amount 0
npm --prefix examples/express-paid-api run test:e2e
```

Required server env vars:

```text
PAID_ROUTE_AMOUNT_BASE_UNITS=25000
PAID_ROUTE_CURRENCY=sol
SOLANA_PAYMENT_RECIPIENT=<recipient-wallet>
SOLANA_RPC_URL=http://127.0.0.1:8899
MPP_SECRET_KEY=<server-secret>
COMMERCE_CATALOG_JSON=<catalog-json>
```

`PAID_ROUTE_AMOUNT_BASE_UNITS` is always an integer. `PAID_ROUTE_CURRENCY=sol` uses lamports. For SPL tokens, set `PAID_ROUTE_CURRENCY` to the mint address and provide `PAID_ROUTE_DECIMALS`; the older `PAID_ROUTE_CURRENCY_MINT` env var is still accepted for compatibility.

For local Surfpool, set `SOLANA_PAYMENT_NETWORK=localnet` and `SOLANA_RPC_URL=http://127.0.0.1:8899`. For devnet or mainnet-beta, set `SOLANA_PAYMENT_NETWORK` to `devnet` or `mainnet-beta`, point `SOLANA_RPC_URL` at the matching RPC provider, and use recipients, SPL mint addresses, and decimals that exist on that network. The example has local Surfpool E2E evidence; devnet and mainnet-beta configuration is supported by the same variables but must be verified against the chosen RPC and assets before launch.

`COMMERCE_CATALOG_JSON` is server-owned catalog configuration for premium products, marketplace products, metered plans, and subscription plans. The local example uses an in-memory `AtomicCommerceStore`; a deployed service should provide a durable Redis, Upstash, database, or equivalent adapter for the MPP replay store, commerce state, receipt claims, session reservations, and renewal records. That adapter must serialize `transaction()` writes so receipt claims and state transitions commit together.

Marketplace splits are passed to Pay Kit MPP as part of the payment contract. The verified local SPL split case credits seller, platform, and referrer token accounts from the accepted settlement and the app fulfills only after `Payment-Receipt` is accepted. Keep split policy server-owned and reject replay against a different split digest.

Metered sessions are app-managed incremental settlement. Creating a session does not charge the payer. Each settlement reserves units with an idempotency key, computes `unitPriceBaseUnits * units`, issues a payment challenge for that operation, and increments `usedUnits` once after receipt-backed settlement. Expired, closed, over-limit, and conflicting idempotency attempts return errors before fulfillment.

Subscription renewals are explicit operations. The client supplies `accountId`, `planId`, strict `YYYY-MM` period, and an idempotency key. The app creates a pending period, charges the configured period price, and marks that period `active` after receipt-backed settlement. There is no scheduler or automatic recurring charge in this example.
