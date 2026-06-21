# Security Checklist

Use this checklist before claiming any Solana-paid route is ready.

## Challenge integrity

- Challenge is generated server-side.
- Challenge includes method, path, amount, token, recipient, network, product ID, nonce, and expiry.
- Client cannot override amount or recipient.
- Nonce is single-use or scoped to an idempotent fulfillment record.

## Settlement verification

- Server verifies the payment with the current Pay Kit SDK, official verifier, or trusted on-chain/RPC logic.
- Verification checks token mint, recipient, amount, payer, network, confirmation status, and reference/memo/intent.
- Server does not trust client callbacks, screenshots, or raw signatures without verifying details.
- For this repository example, verification evidence is `Payment-Receipt` parsing, transaction lookup by receipt reference, balance-delta checks, and state transition checks in the Surfpool E2E suite.
- Paid tool calls should run the paid operation only after settlement acceptance, then persist receipt and output metadata.

## Replay protection

- Proof cannot be reused for a different route, user, product, amount, or recipient.
- Stale proofs expire.
- Duplicate proofs return the same fulfillment result instead of fulfilling twice.
- Split policy is part of the payment intent. Reject a receipt whose split digest differs from the prepared operation.
- Receipt references are claimed once across metered settlements and renewal operations.
- Persist replay records in durable storage for services that restart or run more than one instance.

## Failure handling

- User rejects signature.
- Payment sent but not confirmed.
- RPC timeout after submission.
- Wrong token or amount.
- Recipient mismatch.
- Product generation fails after payment.
- Client retries the paid request.

## Operational safety

- Separate sandbox/devnet/mainnet configuration.
- Secrets and fee-payer keys are server-only.
- Logs redact private keys and wallet auth tokens.
- Receipts include enough detail for support without leaking private data.
- Legal/compliance review is called out for regulated payments, subscriptions, taxes, or custodial behavior.

## Express example checks

Before using the example as a reference, run:

```bash
npm run verify
surfpool start --ci --offline --airdrop-amount 0
npm run example:e2e
```

The normal suite does not require Surfpool. The Surfpool suite currently proves native SOL report payment, native SOL paid wallet tool access, SPL premium access, SPL marketplace split settlement, SPL metered session settlement, SPL subscription renewal, and adversarial replay or settlement rejection cases.

When adapting the example:

- Keep `COMMERCE_CATALOG_JSON` server-owned; do not let clients submit amount, recipient, currency, decimals, or split policy.
- Keep `SOLANA_PAYMENT_NETWORK`, `SOLANA_RPC_URL`, recipient addresses, SPL mint addresses, and decimals aligned to localnet, devnet, or mainnet-beta.
- Replace the memory store with a Redis, Upstash, database, or equivalent `AtomicCommerceStore` adapter for deployed replay protection.
- Keep session settlement incremental and idempotency-keyed; do not increment usage until receipt-backed settlement completes.
- Keep subscription renewal explicit; this example activates the requested period after payment and does not perform automatic recurring charges.
