# Workflow: Metered Session

Use this workflow for streaming APIs, long-running agent jobs, subscriptions, or usage-based billing where a single fixed-price request is not enough.

## Session model

- Start session with an intent or deposit-like authorization.
- Track usage units server-side.
- Periodically settle or close the session.
- Return receipts for each settlement or final close.

The Express example uses app-managed incremental settlement instead of a pre-funded deposit. A session starts without charging the payer. Each settlement request reserves units with an idempotency key, computes `unitPriceBaseUnits * units`, issues a payment challenge for that operation, and increments `usedUnits` after receipt-backed settlement.

## Design questions

- What is the billable unit: request, token, second, row, file, report, or streamed chunk?
- What is the maximum user exposure before settlement?
- Can the service stop mid-session if payment fails?
- Does the product need refunds or credits?
- Is a fee payer or sponsor involved?

## State machine

```text
created -> active -> settling -> active
                 \-> expired
                 \-> closed
```

## Required safeguards

- Usage counter is server authoritative.
- Session has max spend and expiry.
- Fulfillment is resumable.
- Client reconnects do not duplicate charges.
- Settlement failure pauses or closes the session.
- Settlement reservations include an expiry and an idempotency key.
- Receipt references are claimed once so one payment cannot complete another operation.
- Expired, closed, over-limit, and conflicting idempotency attempts fail before fulfillment.

## Reference implementation

Use these files for the current verified shape:

- `examples/express-paid-api/src/commerce-service.ts`: session creation, settlement preparation, completion, expiry, limits, and receipt-claim checks.
- `examples/express-paid-api/src/commerce-store.ts`: JSON-safe memory store plus the `AtomicCommerceStore` interface expected from durable adapters.
- `examples/express-paid-api/src/server.ts`: `/api/v1/sessions`, `/api/v1/sessions/:sessionId`, and `/api/v1/sessions/:sessionId/settlements` routes.

The Surfpool settlement suite verifies a real SPL metered-session settlement and checks that `usedUnits` increments after `Payment-Receipt` acceptance. The adversarial suite verifies expired and over-limit settlement attempts and idempotency conflict behavior.

## Subscription renewal pattern

The example also includes explicit renewal operations at `POST /api/v1/subscriptions/renewals`. A renewal is keyed by `accountId`, `planId`, strict `YYYY-MM` period, and idempotency key. The service creates a pending period, charges the configured period price, and marks that period `active` after receipt-backed settlement. It does not implement automatic recurring billing.

## Durable store boundary

For process restarts or multiple server instances, replace the memory store with Redis, Upstash, a database, or equivalent storage that implements `AtomicCommerceStore`. The `transaction()` callback must commit receipt claims, session state, and subscription state together or roll the operation back.
