# Solana Agentic Commerce Skill

AI-agent skill for building Solana-paid APIs, paid agent tool calls, stablecoin paywalls, marketplace splits, metered sessions, and x402/MPP-style commerce flows with Solana Pay Kit patterns.

This submission targets the Superteam Brasil bounty: **Ship useful agent skills we can add to Solana AI Kit**.

## Why this skill

Solana AI Kit already covers broad Solana development, DeFi, infrastructure, security, mobile, games, and ecosystem skills. The missing builder workflow is agentic commerce: helping founders turn an API, dataset, AI tool call, or SaaS feature into a paid Solana service.

This is intentionally **not** a Pay Kit SDK port. It is an application-integration skill for builders using Pay Kit, x402-style single-recipient flows, and MPP-style richer payment intents.

## What it helps build

- Paid API endpoints using HTTP `402 Payment Required`
- Paid AI tool calls and agent-to-agent commerce
- Stablecoin paywalls for premium content, reports, datasets, and model/tool access
- Marketplace routes with platform fees and recipient splits
- Metered sessions and subscription-style settlement patterns
- Security reviews for payment proof, replay protection, and settlement verification

## Skill layout

```text
.
|-- SKILL.md
|-- references/
|   |-- pay-kit-overview.md
|   |-- payment-protocols.md
|   `-- security-checklist.md
|-- workflows/
|   |-- add-paywall-to-api.md
|   |-- agent-paid-tool-call.md
|   `-- metered-session.md
|-- templates/
|   |-- express-paid-middleware.ts
|   `-- nextjs-paid-route.ts
`-- commands/
    |-- paywall-plan.md
    `-- paywall-review.md
```

## Example prompts

```text
Use $solana-agentic-commerce to add a 0.10 USDC paywall to my Next.js /api/report route.
```

```text
Use $solana-agentic-commerce to design an agent-to-agent paid tool call where my research agent pays for a premium Solana wallet analysis.
```

```text
Use $solana-agentic-commerce to review this Express payment middleware for replay protection and settlement verification gaps.
```

## Install

For Codex/Claude-style skill folders, copy this folder into your agent skills directory or add it as a repository skill source.

For Solana AI Kit integration, the useful unit is the `SKILL.md`, `references/`, `workflows/`, `templates/`, and `commands/` set. The root is kept simple so it can be copied into `ext/` or a marketplace layout.

## Sources used

- Solana Pay Kit: https://github.com/solana-foundation/pay-kit
- Solana AI Kit: https://github.com/solanabr/solana-ai-kit
- SendAI Solana skills marketplace: https://github.com/sendaifun/skills
- Solana payments reference: https://github.com/solana-foundation/solana-dev-skill

## Status

Bounty submission candidate. Templates use the released `@solana/mpp/server` and `mppx/express` surfaces, require server-side payment configuration before a paid route can start, and fail closed when required payment configuration is missing.

## Working example

The `examples/express-paid-api` app is the runnable reference path for this skill. It gates `/api/v1/agent-report` with the current TypeScript Pay Kit package:

```ts
import { solana } from "@solana/mpp/server";
import { Mppx } from "mppx/express";
```

Run locally after installing dependencies:

```bash
npm --prefix examples/express-paid-api install
npm --prefix examples/express-paid-api run typecheck
npm --prefix examples/express-paid-api test
```

Required server env vars:

```text
PAID_ROUTE_AMOUNT_BASE_UNITS=1000
PAID_ROUTE_CURRENCY_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
PAID_ROUTE_DECIMALS=6
SOLANA_PAYMENT_RECIPIENT=<recipient-wallet>
SOLANA_RPC_URL=https://402.surfnet.dev:8899
MPP_SECRET_KEY=<server-secret>
```

`PAID_ROUTE_AMOUNT_BASE_UNITS` is always an integer. With a six-decimal token, `1000` equals `0.001` token. The example's integration test starts a real Express server and confirms that an unpaid request receives the SDK's actual `402 Payment Required` challenge; it never bypasses settlement verification.
