# Modeling Agent

`modeling-agent` is a local mathematical-modeling competition agent. It turns a problem package into a typed task graph, executes real Python experiments, records an evidence trail, and exports a reproducible project package.

The current target is `v0.1-alpha`: broad support for common task families with explicit evidence levels. It is not a claim that every modeling problem can be solved reliably or at award-winning quality.

## Architecture

```text
CLI / local Web UI
        |
Application Service (Fastify is an adapter, not the owner)
        |
Orchestrator -- SQLite state -- Artifact store
   |        |             |
AgentRuntime TaskPlugin   ResearchGateway
pi / fake   registry      OpenCLI
   |
Docker Python experiment workers
   |
Evidence Graph -> report -> project package
```

The outer lifecycle is fixed. A planner creates a Schema-constrained inner task graph using these task families:

- statistical analysis
- regression and prediction
- time-series forecasting
- classification
- clustering
- evaluation and ranking
- optimization
- simulation
- experimental fallback for long-tail methods

## Development Status

The repository is being built as a vertical slice. See [the alpha specification](docs/spec/v0.1-alpha.md) and [implementation plan](docs/spec/two-week-plan.md) for the frozen boundary and milestones.

## Prerequisites

- Node.js 24 LTS
- Python 3.11
- Docker
- XeLaTeX with CTeX for Chinese reports
- OpenCLI for audited web research

## Commands

```bash
npm ci
npm run check
npm run cli -- run ./tests/fixtures/basic --runtime fake --execution local
npm run cli -- list
npm run cli -- show <run-id>
npm run cli -- export <run-id> ./project.zip
npm run cli -- reproduce <run-id>
```

Use `--runs-root <path>` before the subcommand to select a separate run database/workspace, and add `--json` to a subcommand for machine-readable output. The fake runtime is deterministic and intended for tests; the pi SDK runtime remains optional and isolated behind `AgentRuntime`.

The local execution path is the supported alpha baseline. Docker execution is constrained with no network, a read-only root, resource limits, read-only input mounts, and a writable output mount; the default `python:3.11-slim` image does not bundle the numerical stack, so configure a compatible image before expecting Docker tasks to succeed. Report generation always emits `report.md`, `report.tex`, and a real `report.pdf`; when XeLaTeX is unavailable or the TeX source cannot compile, a built-in PDF renderer is used and `report-status.json` records the limitation.

## Security

Generated code is untrusted. It is policy-checked and executed in a constrained container. Network research is mediated by `ResearchGateway`; browser and model credentials are never written to run state or exported projects.

## License

Apache-2.0. Competition data, papers, and user-provided materials retain their original rights and are not part of this repository.
