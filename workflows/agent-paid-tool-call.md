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
- The server should accept tool output only after settlement verification through Pay Kit or equivalent on-chain/RPC checks.
- Replay protection must bind the proof to method, path, amount, recipient, asset, network, and tool input identity.

## Reference implementation

Use `examples/express-paid-api/src/server.ts` as the current Express reference. The route `POST /api/v1/tools/wallet-analysis`:

1. Validates the requested wallet address before issuing the paid challenge.
2. Builds an operation-specific `externalId` from the tool name and requested wallet.
3. Uses `@solana/mpp/server` and `mppx` to require a native SOL payment.
4. Reads live balance data through `examples/express-paid-api/src/rpc.ts` only after payment acceptance.

The Surfpool settlement suite pays this route through `@solana/mpp/client`, parses `Payment-Receipt`, fetches the transaction by receipt reference, and checks recipient lamport delta. The adversarial suite checks that captured Authorization material cannot be reused against a different route or amount.

## Replay and settlement records

For a deployed tool provider, persist these records in a durable store:

- payment challenge or operation ID
- tool input hash and caller account
- `Payment-Receipt` reference and transaction signature
- settlement timestamp, amount, currency, recipient, and network
- output hash and fulfillment status

The example memory store is for local process lifetime only. Use a Redis, Upstash, database, or equivalent `AtomicCommerceStore` adapter when replay records must survive restarts.

## Useful output

For agent workflows, generate:

- payment policy
- tool schema changes
- challenge/response shape
- approval threshold
- receipt persistence model
- failure handling for unpaid, rejected, timeout, and duplicate tool calls
- verification command, such as `npm run example:e2e`, when using this repository example
