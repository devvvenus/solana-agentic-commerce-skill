---
name: solana-agentic-commerce
description: Use when building Solana-paid APIs, agent-to-agent paid tool calls, stablecoin paywalls, x402/MPP routes, marketplace splits, metered sessions, subscriptions, or Pay Kit commerce flows for AI agents, SaaS products, datasets, APIs, and backend services.
---

# Solana Agentic Commerce

## Overview

Use this skill to turn an API route, AI tool call, dataset, SaaS feature, or agent workflow into a Solana-paid service. Prefer Solana Pay Kit for HTTP `402 Payment Required` flows, x402-style single-recipient payments, and MPP-style intents for splits, fee-payer separation, metered sessions, and marketplaces.

This is not an SDK-porting skill. It is a builder workflow skill for applying Pay Kit and Solana payment patterns inside real products.

## Route Selection

| User asks for | Read next |
|---|---|
| Paid API endpoint, SaaS paywall, premium route | `references/pay-kit-overview.md`, then `workflows/add-paywall-to-api.md` |
| Agent pays another API/tool/agent | `references/payment-protocols.md`, then `workflows/agent-paid-tool-call.md` |
| Marketplace split, platform fee, sponsored fee payer | `references/payment-protocols.md`, then `references/security-checklist.md` |
| Metered usage, session billing, subscriptions | `workflows/metered-session.md`, then `references/security-checklist.md` |
| Security review of an existing payment route | `references/security-checklist.md`, then `commands/paywall-review.md` |
| Need starter code | Use `templates/nextjs-paid-route.ts` or `templates/express-paid-middleware.ts` as the starting point |
| Need a verified Express reference | Read `README.md`, then inspect `examples/express-paid-api/src/server.ts`, `src/catalog.ts`, `src/commerce-service.ts`, `src/commerce-store.ts`, and the tests under `examples/express-paid-api/test/` |

## Core Workflow

1. Classify the paid surface: single route, agent tool call, marketplace action, metered session, or subscription.
2. Pick the protocol shape:
   - Use x402-style flow for one endpoint, one price, one recipient.
   - Use MPP-style intent when you need splits, platform fees, fee-payer separation, gasless UX, or richer settlement rules.
3. Define the payment contract before code:
   - method and path
   - price, currency (`sol` or SPL mint), decimals for SPL tokens, recipient
   - network and confirmation level
   - nonce/reference lifetime
   - replay policy
   - refund and failure behavior
4. Generate the route or middleware from the closest template.
5. Add settlement verification that queries chain or trusted Pay Kit verifier state; do not trust client callbacks alone.
6. Add tests for unpaid request, paid replay, stale nonce, wrong amount, wrong recipient, duplicate proof, rejected signature, and timeout.
7. Produce a short operator note explaining keys, RPC requirements, sandbox/devnet/mainnet settings, and known limitations.

## Verified Example Path

The runnable reference is `examples/express-paid-api`. It demonstrates:

- `GET /api/v1/agent-report` and `POST /api/v1/tools/wallet-analysis` paid with native SOL.
- `GET /api/v1/premium/:productId`, `POST /api/v1/marketplace/:productId/purchase`, metered session settlements, and subscription renewals paid with SPL tokens in the Surfpool E2E suite.
- `Payment-Receipt` parsing, transaction lookup by receipt reference, balance-delta checks, and app state transitions after settlement.
- Replay checks for same-route reuse, route mismatch, amount mismatch, split-policy mismatch, idempotency conflict, expired sessions, and unit-limit failures.

Use this example as the first implementation reference when the user asks for paid tool calls, metered sessions, replay protection, or settlement verification.

## Required Safety Checks

Every paid route must show or log the exact recipient, currency, amount, network, and product being purchased before payment is signed. Every server must bind payment proof to the original request intent, reject stale nonces, and prevent proof reuse across routes or users.

Never tell the user that a route is production-ready until it has:

- server-side settlement verification
- replay protection
- idempotent fulfillment
- timeout and partial-failure handling
- tests for wrong amount, wrong recipient, stale proof, and duplicate proof
- clear environment separation for sandbox, devnet, and mainnet

For persistent services, replace the example memory store with a durable `AtomicCommerceStore` adapter backed by Redis, Upstash, a database, or equivalent storage. The adapter must serialize `transaction()` writes for receipt claims, replay records, session reservations, and subscription period state.

## Templates

Use templates as integration skeletons. For TypeScript backends, prefer `@solana/mpp/server` with `Mppx.create({ methods: [solana.charge(...)] })` so settlement verification stays inside the published Pay Kit middleware surface. Express integrations also use the official `mppx/express` adapter.

- `templates/nextjs-paid-route.ts`: Next.js App Router paid endpoint shape.
- `templates/express-paid-middleware.ts`: Express middleware shape for existing APIs.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Treating a tx signature as enough proof | Verify recipient, amount, token, network, memo/reference, and confirmation status |
| Reusing one static challenge | Generate a scoped nonce per request intent with expiry |
| Charging before checking route authorization | Check auth and product eligibility before issuing the payment challenge |
| Fulfilling twice on retry | Use idempotency keyed by payment proof and request intent |
| Building only a superficial checkout | Include agent/client replay flow and server verification |
| Copying Pay Kit SDK internals | Use Pay Kit as dependency/reference; make this skill about app integration |

## Output Shape

When using this skill, return:

1. The selected commerce pattern and why.
2. A concrete payment contract table.
3. The route/middleware changes.
4. The verification and replay-protection plan.
5. A minimal test matrix.
6. Any assumptions that must be verified against the current Pay Kit SDK.
