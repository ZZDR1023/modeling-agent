# Architecture

## Ownership

The system is a modular monolith. The Orchestrator is the single writer and owns state transitions. Agent sessions, research workers, and Python workers propose candidate outputs in isolated staging directories.

## Runtime Boundary

Business logic depends on `AgentRuntime`, not pi. `PiRuntimeAdapter` embeds the pi SDK with one isolated, tool-minimal session per stage. `FakeRuntimeAdapter` provides deterministic fixtures and fault injection for tests.

## Artifact Commit

```text
staging output
  -> JSON Schema validation
  -> policy and semantic validation
  -> file inventory and SHA-256
  -> evidence registration
  -> SQLite transaction
  -> atomic directory rename
```

No downstream stage can read uncommitted staging output.

## Research Boundary

`ResearchGateway` prefers structured public adapters and APIs, then webpage extraction, then an owned browser session. Every response is snapshotted and hashed. During blind solve, a reference firewall quarantines likely same-problem solutions.

## Reproducibility

Experiments and reports are deterministically rebuildable from frozen inputs and committed evidence. Full Agent reruns are auditable and quality-repeatable, but LLM wording and plans are not promised to be byte-identical.
