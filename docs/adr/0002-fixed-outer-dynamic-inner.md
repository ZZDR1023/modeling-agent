# ADR 0002: Fixed Outer Lifecycle, Typed Dynamic Task Graph

- Status: accepted
- Date: 2026-08-07

## Context

Mathematical-modeling problems combine heterogeneous subproblems. A fully fixed workflow cannot cover them, while unconstrained LLM planning can skip evidence, safety, and delivery stages.

## Decision

Keep import, planning, review, execution, evidence, report, audit, and export as a fixed outer lifecycle. Let the planner propose an inner DAG using registered task types and versioned Schema. Independently review requirement coverage before freezing the graph.

## Consequences

Long-tail methods can run through an experimental node without acquiring new permissions. Generality is measurable as graph and execution coverage, not asserted from a prompt.

## Validation

Reject cycles, missing requirements, unknown dependencies, duplicate IDs, unregistered task types, and nodes without evaluation or evidence contracts.
