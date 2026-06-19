# Complete Agentic Commerce Flows Design

## Goal

Turn every capability advertised by the skill into an executable, testable flow without simulated payment success. The example must prove HTTP 402 payments, paid agent tools, SPL stablecoin settlement, marketplace splits, metered usage, subscription renewal, replay protection, and settlement verification using the published Solana MPP SDK.

## Scope

The runnable Express example will expose six commerce surfaces:

1. Fixed-price paid report.
2. RPC-backed paid wallet analysis tool for agent callers.
3. SPL-token premium-content paywall.
4. Atomic marketplace purchase with seller, platform, and referrer recipients.
5. Server-authoritative metered session with paid incremental settlement.
6. Subscription-style plan renewal with an explicit billing period.

All mandatory end-to-end tests run against Surfpool with real transactions. The same application configuration supports `devnet` and `mainnet-beta`, but CI never requires funded external wallets or public RPC availability.

## Non-Goals

- No custody of user private keys.
- No unattended mainnet spending in CI.
- No claim of native Solana payment-channel support. The installed `@solana/mpp` release publishes charge support, split payments, SPL tokens, and replay protection, but not a supported TypeScript Solana session server.
- No fabricated payment callbacks, synthetic receipts, simulated RPC settlement, or hard-coded successful transaction responses.
- No calendar scheduler. Subscription renewal is an authenticated billing-period charge endpoint that can be invoked by a customer or an external scheduler.

## Architecture

### Payment layer

`CommercePaymentService` owns MPP method construction. Every route receives a server-owned payment contract containing amount, currency, decimals, recipient, network, RPC URL, optional split recipients, and challenge lifetime. It creates `solana.charge()` methods and injects one shared atomic MPP store so consumed signatures remain protected across all routes in the running service.

Production deployments provide a Redis or Upstash-backed atomic store through the adapters exported by `mppx`. Local development and deterministic tests use the SDK's atomic in-memory store. The application never trusts a client callback or a transaction signature without MPP verification.

### Commerce state layer

`CommerceStore` owns fulfillment, sessions, and subscriptions. Its interface supports atomic read-modify-write operations so concurrent retries cannot duplicate fulfillment or over-consume a session. The runnable example provides an in-process implementation and exposes the boundary required for a durable database implementation in a deployed service.

MPP proof consumption and application fulfillment are separate controls:

- MPP prevents a payment credential from being reused.
- Commerce idempotency prevents a successful payment retry from delivering or accounting twice.

### HTTP layer

Express routes validate request data before computing a payment contract. Payment middleware executes before protected work. Paid handlers receive only verified requests and attach the MPP receipt to the response.

## Route Contracts

### `GET /api/v1/agent-report`

Fixed-price report route retained as the minimal HTTP 402 example. An unpaid request returns a machine-readable challenge; a valid payment returns the report and `Payment-Receipt`.

### `POST /api/v1/tools/wallet-analysis`

Input contains a Solana address. After payment, the tool queries the configured RPC for the address balance and returns a deterministic analysis object containing address, lamports, SOL amount, network, and observation time. This is an actual RPC-backed tool call with live chain data.

### `GET /api/v1/premium-content/:contentId`

The server maps `contentId` to a server-owned SPL-token price. A generated Surfpool mint is used in E2E; devnet/mainnet use configured mint addresses and decimals. Paid responses contain the requested content record and receipt.

### `POST /api/v1/marketplace/purchases`

The server maps a product ID to total price and recipient policy. One MPP charge contains the primary seller plus platform and referrer splits. The sum of split amounts must be less than the total so the seller receives the remainder. E2E verifies all token-account balance deltas from the same transaction reference.

### `POST /api/v1/sessions`

Creates a server-authoritative usage session with customer ID, unit price, maximum units, expiry, and zero settled units. Session creation does not claim payment.

### `POST /api/v1/sessions/:sessionId/settlements`

Input requests a positive number of additional usage units and an idempotency key. The server validates remaining capacity and computes the amount. A real MPP charge settles that increment. After verification, an atomic state transition increases settled and consumed units exactly once. Duplicate idempotency keys return the original fulfillment without a second accounting transition. Expired, closed, or over-limit sessions fail closed.

### `POST /api/v1/subscriptions/:planId/renewals`

Input contains customer ID, billing period, and idempotency key. Plan price and duration come only from server configuration. A verified charge activates that exact period. Repeating the same idempotency key returns the recorded renewal; attempting a second distinct payment for an already active period is rejected unless the route policy explicitly allows extension.

## Configuration

Common configuration:

- `SOLANA_PAYMENT_NETWORK=localnet|devnet|mainnet-beta`
- `SOLANA_RPC_URL`
- `MPP_SECRET_KEY`
- `MPP_REALM`
- `PAYMENT_CURRENCY=sol|<SPL mint>`
- `PAYMENT_DECIMALS` for SPL tokens
- server-owned recipient addresses and split amounts
- session unit price, maximum units, and expiry
- subscription plan price and period duration

Configuration parsing rejects missing recipients, invalid addresses, non-integer base-unit amounts, invalid decimals, negative split amounts, split totals greater than or equal to total price, unsupported networks, and weak MPP secrets.

## Security Model

1. Challenges are created by the server from route configuration.
2. Amount, currency, recipient, network, and split table are bound to the credential challenge by MPP.
3. MPP verifies the signed transaction, expected instructions, confirmation status, and recipient transfers on-chain.
4. A shared atomic store tracks consumed signatures for replay prevention.
5. Route and product identifiers are bound through server-selected contracts and external IDs where supported.
6. Idempotency keys are scoped to customer, operation, and resource.
7. Paid work executes only after verification.
8. Logs and API responses never expose private keys, MPP secrets, or raw wallet authorization material.

## Test Strategy

### Unit and integration tests

- Reject invalid network, amount, decimals, address, weak secret, and split policies.
- Verify unpaid requests return 402 and never execute protected work.
- Verify session capacity, expiry, monotonic accounting, and idempotent fulfillment.
- Verify subscription period activation and duplicate renewal behavior.
- Verify malformed input fails before payment challenge creation.

### Real Surfpool E2E tests

- Native SOL fixed-price report payment.
- Paid agent wallet-analysis call using live Surfpool RPC data.
- Create a real SPL mint, token accounts, and payer token balance.
- SPL premium-content payment with receipt and recipient token delta.
- Atomic SPL marketplace purchase with seller, platform, and referrer deltas verified against one transaction.
- Metered-session settlement with on-chain payment and exactly-once usage accounting.
- Subscription renewal with on-chain payment and active-period state.

### Adversarial tests

- Replay the same authorization against the same route.
- Replay a credential against a different route or product.
- Submit a credential bound to the wrong amount.
- Submit a credential bound to the wrong recipient or split table.
- Reuse an idempotency key with conflicting input.
- Attempt settlement after session expiry or beyond maximum units.
- Confirm all failures withhold protected content and do not mutate fulfillment state.

## CI and Verification

`npm run verify` performs repository validation, TypeScript checks, integration tests, and dependency audit. `npm run example:e2e` runs the complete real-settlement suite against Surfpool. GitHub Actions keeps a fast verification job and a dependent Surfpool E2E job. Both are required to pass before release.

## Documentation

README will contain a capability matrix distinguishing implemented and verified flows from configurable deployment targets. Each flow will include its endpoint, payment asset, verification command, and production persistence note. Skill workflows and templates will point to the runnable implementations rather than describing unsupported native session behavior.

## Acceptance Criteria

- Every advertised capability maps to a runnable endpoint and at least one passing test.
- Stablecoin and marketplace tests move real SPL tokens on Surfpool.
- Marketplace recipients are paid atomically in one verified transaction.
- Metered and subscription flows produce real on-chain settlements and exactly-once application state transitions.
- Replay, cross-route replay, wrong-contract, stale-session, and conflicting-idempotency tests fail closed.
- No test substitutes a simulated RPC response or fabricated receipt for settlement success.
- Devnet and mainnet require configuration only, not source changes.
- `npm run verify`, `npm run example:e2e`, dependency audit, and GitHub Actions all pass.
