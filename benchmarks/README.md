# Benchmark harness

This directory contains redistributable synthetic fixtures and metadata-only guidance for historical cases. It does **not** claim that three historical competition problems have been run, and protected problem statements or reference answers are not committed by default.

## Run the synthetic suite

From the repository root:

```bash
npx tsx src/benchmark/run-synthetic.ts --output benchmarks/output/synthetic
```

The command writes `benchmark-report.json` and `benchmark-report.md`. It runs the deterministic agent and one-shot adapters against the same frozen bytes for each case, uses a deterministic clock and identity, and is suitable for checking stable report fields. `benchmarks/output/` is intended as local generated output; do not commit reports that contain non-synthetic operational data.

The harness API is injected: production integrations implement `BenchmarkAdapter` from `src/benchmark/types.ts` instead of importing CLI or Orchestrator modules. A solve adapter receives package files, budgets, expected task types, and hard-check definitions. It never receives the manifest object, a reference path, reference bytes, or scoring notes. Reference material is opened separately for post-solve leakage checks, and a detected same-problem answer changes the result to `blocked` / `blocked_policy` with a digest-only event.

## Adding three historical problems legally

The v0.1-alpha acceptance target calls for three historical blind runs spanning at least six task families and one custom experiment. This repository currently supplies no such score and must not be described as having completed that target. Add each historical case only after all of the following steps:

1. **Establish rights before copying.** Record the organizer, copyright holder, official source URL, license or written permission, and redistribution terms. A public download link is not by itself permission to republish a statement, dataset, judge material, or solution.
2. **Prefer user-supplied private material.** For ordinary copyrighted competitions, set `license.redistribution` to `user_supplied_only` or `metadata_only`, set reference availability to `user_supplied` or `unavailable`, and keep problem packages and answers under the ignored `benchmarks/private/` directory. Do not commit them.
3. **Create metadata without answer text.** Give the case a stable id, declare allowed and expected task types, budgets, runtime/execution policy, and hard checks. Store only relative paths and SHA-256 identities. Never place a reference answer, excerpt from a solution, credential, session, or absolute host path in a manifest or report.
4. **Freeze one case for both variants.** Verify that agent and one-shot runs receive the exact same `frozen_case_sha256`, budget, expected-task denominator, and hard-check definitions. Do not tune either variant after viewing the other variant's result.
5. **Keep scoring references out of solve.** Reference solutions and judge notes are scoring-only. The blind firewall must block a detected same-problem answer and retain only a fingerprint, never the matched text.
6. **Report missing measurements honestly.** Unknown token count, cost, or human review is `unavailable` with a `null` value. An unavailable field is not zero. Material not obtained or a run not attempted is `not_run`; a policy stop is `blocked`; failures never count as completion.
7. **Review before publication.** Have a maintainer confirm the license record and inspect the staged diff for protected text. Publish historical results only when the underlying case can be lawfully used and the environment/commit identity is reproducible.

A practical three-case plan is to select cases with independently verified reuse permission, assign each a separate private case root, and run both variants offline. Until those materials and permissions exist, retain metadata placeholders outside committed synthetic results rather than inventing scores.

## Contract files

- `schemas/benchmark-manifest.v1.json`: strict manifest boundary.
- `schemas/benchmark-result.v1.json`: strict result and metric-state boundary.
- `src/benchmark/contracts.ts`: Schema validation plus cross-field invariants.
- `src/benchmark/runner.ts`: frozen-package runner and blind leakage firewall.
- `src/benchmark/report.ts`: deterministic JSON and Markdown aggregation.
