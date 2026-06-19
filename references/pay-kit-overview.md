# Pay Kit Overview

Use Solana Pay Kit as the default reference when the user wants paid HTTP routes, stablecoin paywalls, agent-paid APIs, or programmable payment flows on Solana.

## Mental model

The server protects a resource. An unpaid request receives `402 Payment Required` with a challenge. The client or agent signs and submits a payment, then replays the original request with a payment proof. The server verifies settlement and returns the protected response.

## Good fits

- API calls priced in USDC or another supported stablecoin
- paid reports, datasets, AI tool calls, and premium content
- microtransactions where card fees are not viable
- agent-to-agent payments with no prior account
- marketplace payments with splits or platform fees
- metered sessions where usage is paid incrementally

## Do not use it for

- refunds, chargeback-like flows, or reversible payments without separate business logic
- regulated financial products without legal review
- custody flows where the app controls user funds
- blind client-side-only verification

## Integration checklist

1. Identify the protected resource and user-visible value.
2. Choose one token and network for the first version.
3. Define price and recipient in server config, not client input.
4. Issue one scoped challenge per request intent.
5. Require payment proof on replay.
6. Verify settlement server-side.
7. Fulfill idempotently.
8. Persist receipt, route, amount, recipient, payer, tx signature, and fulfillment status.

## Naming guidance

Use product language in generated code and docs: `paid report`, `premium route`, `tool access`, `usage session`, `receipt`, `settlement`. Avoid presenting the flow as a superficial checkout.

## Current TypeScript surface

For TypeScript/Node services, use `@solana/mpp`.

Server route gating with the released `@solana/mpp@0.6.x` API:

```ts
import { Mppx, solana } from "@solana/mpp/server";

const mppx = Mppx.create({
  secretKey,
  realm,
  methods: [solana.charge({ recipient, currency: usdcMint, decimals: 6, network, rpcUrl })],
});

const result = await mppx.charge({ amount: "1000", description: "Paid endpoint" })(request);
if (result.status === 402) return result.challenge;
return result.withReceipt(Response.json({ data: "paid result" }));
```

Amounts are integer base units. For a six-decimal token, `1000` means `0.001` token. Never pass a display decimal such as `"0.001"` to `amount`.

Client support is exposed from `@solana/mpp/client`; select the client method that matches the server challenge and wallet implementation. Do not assume an unreleased convenience factory exists.

```ts
import { Mppx, solana } from "@solana/mpp/client";
```
