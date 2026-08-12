# Orchestrator Rules

- This module is the only state and committed-artifact writer.
- State transitions must be explicit, validated, and appended to the event log.
- Never accept Worker-declared success without contract, policy, semantic, and hash checks.
- Freeze the task graph and evaluation contracts before experiment outcomes are visible.
- Retries create attempts; they do not mutate an old attempt.
- A changed upstream artifact marks dependent artifacts stale.
- Keep the fixed outer lifecycle independent of concrete modeling methods.
