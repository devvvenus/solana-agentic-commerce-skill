# Workflow: Metered Session

Use this workflow for streaming APIs, long-running agent jobs, subscriptions, or usage-based billing where a single fixed-price request is not enough.

## Session model

- Start session with an intent or deposit-like authorization.
- Track usage units server-side.
- Periodically settle or close the session.
- Return receipts for each settlement or final close.

## Design questions

- What is the billable unit: request, token, second, row, file, report, or streamed chunk?
- What is the maximum user exposure before settlement?
- Can the service stop mid-session if payment fails?
- Does the product need refunds or credits?
- Is a fee payer or sponsor involved?

## State machine

```text
created -> payment-required -> active -> settling -> closed
                         \-> expired
                         \-> failed
```

## Required safeguards

- Usage counter is server authoritative.
- Session has max spend and expiry.
- Fulfillment is resumable.
- Client reconnects do not duplicate charges.
- Settlement failure pauses or closes the session.
