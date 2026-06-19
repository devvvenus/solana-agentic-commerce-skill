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

## Replay protection

- Proof cannot be reused for a different route, user, product, amount, or recipient.
- Stale proofs expire.
- Duplicate proofs return the same fulfillment result instead of fulfilling twice.

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
