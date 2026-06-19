# Workflow: Agent Paid Tool Call

Use this workflow when one agent, script, or backend service must pay another API or tool provider before receiving a result.

## Pattern

1. Calling agent requests the tool normally.
2. Tool provider returns `402 Payment Required` with a machine-readable challenge.
3. Calling agent asks wallet/payment controller to approve or execute payment.
4. Calling agent replays the request with payment proof.
5. Tool provider verifies settlement and returns the tool result plus receipt metadata.

## Required boundaries

- The model should not hold raw private keys.
- Payment approval policy should be explicit: automatic under limit, human approval above limit, or always manual.
- The requested tool action must be bound to the payment challenge.
- Receipt should be saved with input hash, output hash, amount, payer, recipient, and tx signature.

## Useful output

For agent workflows, generate:

- payment policy
- tool schema changes
- challenge/response shape
- approval threshold
- receipt persistence model
- failure handling for unpaid, rejected, timeout, and duplicate tool calls
