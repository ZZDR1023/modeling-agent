# ADR 0001: Use pi As A Replaceable Runtime

- Status: accepted
- Date: 2026-08-07

## Context

The project needs a usable tool-calling and session runtime within two weeks, while retaining ownership of modeling workflow, policy, evidence, and evaluation decisions.

## Decision

Depend on an internal `AgentRuntime` interface. Embed pi through `PiRuntimeAdapter`; use `FakeRuntimeAdapter` for deterministic tests. Stage sessions are isolated and do not share conversation history.

## Alternatives

- A pi extension would ship quickly but make the product boundary look like a customized coding agent.
- A from-scratch model/tool loop would maximize control but consume the alpha schedule on runtime mechanics.
- Forking pi would add upgrade and merge ownership without solving a product requirement.

## Consequences

The project owns all modeling and orchestration decisions, but relies on pi's session and provider behavior. The adapter requires contract tests whenever pi is upgraded.

## Validation

Run the same fixture through fake and pi adapters and assert that both produce the same stage result contract, lifecycle events, abort semantics, and bounded error classification.
