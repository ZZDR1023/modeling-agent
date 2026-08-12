# Runtime Adapter Rules

- Implement the internal `AgentRuntime` contract; do not expose pi types to business modules.
- Create a fresh, tool-minimal session for every stage attempt.
- Do not load user/global pi extensions, skills, context files, or prompts into product sessions.
- Persist the public prompt, model metadata, token usage, output, and lifecycle events after redaction.
- Abort and dispose every session in `finally` blocks.
- Infrastructure retry belongs to the adapter; semantic repair belongs to the Orchestrator.
