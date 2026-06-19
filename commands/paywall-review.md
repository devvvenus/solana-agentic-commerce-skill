# Paywall Review Command

Use this command text when reviewing a payment route for gaps.

```text
Use $solana-agentic-commerce to review this Solana-paid route.

Check for:
- client-controlled amount or recipient
- missing nonce or expiry
- proof replay across route/user/product
- tx signature trusted without settlement verification
- duplicate fulfillment on retry
- poor sandbox/devnet/mainnet separation
- missing tests for wrong amount, wrong recipient, stale proof, duplicate proof, timeout, and fulfillment failure

Return findings first, then a minimal patch plan.
```
