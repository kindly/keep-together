# keep-together — agent instructions

The project rules live in **`CLAUDE.md`** (domain invariants, tenancy,
contracts, validation tiers, commands) — read it first. Its "Convex
guidance" section says how the Convex block below ranks against those
rules: Convex API mechanics come from `convex/_generated/ai/guidelines.md`;
project rules (scoped function constructors outside `convex/platform/`,
`executeContract` for every domain write, `tenantId` on every domain
table, integer-pence money) override the guidelines' generic defaults.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
