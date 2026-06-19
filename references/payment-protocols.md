# Payment Protocol Selection

Choose the simplest payment shape that satisfies the product requirement.

## x402-style flow

Use when the requirement is:

- one route
- one fixed price
- one recipient
- simple pay-and-replay behavior
- minimal integration surface

Output should include:

- route path and method
- amount and token
- recipient address
- challenge expiry
- settlement confirmation policy
- idempotency key

## MPP-style intent

Use when the requirement includes:

- multiple recipients
- platform fees
- fee-payer separation
- gasless or sponsored UX
- richer payment metadata
- marketplace or creator payouts
- metered sessions or subscriptions

Output should include:

- intent ID
- payer and fee payer roles
- recipient split table
- fee policy
- session or subscription boundaries
- settlement and fulfillment state machine

## Decision rule

Start with x402-style unless the user explicitly needs splits, sponsorship, marketplaces, or session accounting. Do not introduce MPP complexity for a single fixed-price route.

## Required explanation

Every generated plan should state why the selected protocol shape is sufficient and what would force a migration to the richer shape later.
