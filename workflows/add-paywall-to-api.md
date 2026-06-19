# Workflow: Add Paywall To API

## Inputs to collect

- Framework: Next.js, Express, FastAPI, Axum, or other
- Route method and path
- Product being sold
- Price, token, network, recipient
- Whether auth is required before payment
- Fulfillment behavior after payment

## Steps

1. Define the payment contract.
2. Add unpaid request handling that returns `402 Payment Required`.
3. Generate a challenge with nonce and expiry.
4. Accept replayed request with payment proof.
5. Verify settlement server-side.
6. Persist receipt and fulfillment status.
7. Return protected response.
8. Add test cases from the matrix below.

## Test matrix

| Case | Expected behavior |
|---|---|
| No payment proof | 402 challenge |
| Valid proof | 200 protected response |
| Wrong amount | 402 or 403 with clear error |
| Wrong recipient | 402 or 403 with clear error |
| Expired challenge | New 402 challenge |
| Duplicate proof | Idempotent replay of prior fulfillment |
| Settlement timeout | 202 pending or retryable error |
| Fulfillment failure after payment | Receipt stored; recovery path documented |

## Output requirements

Return the code change, the payment contract, the verification assumptions, and the exact tests the user should run.
