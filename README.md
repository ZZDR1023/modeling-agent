# Modeling Agent

[![CI](https://github.com/ZZDR1023/modeling-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/ZZDR1023/modeling-agent/actions/workflows/ci.yml)

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

The local execution path is the supported alpha baseline. Build the pinned Docker worker image with `docker build -t modeling-agent-python:0.1-alpha python/`, then set `MODELING_AGENT_PYTHON_IMAGE=modeling-agent-python:0.1-alpha` (or pass the equivalent worker option); Docker execution uses module invocation, no network, a read-only root, resource limits, read-only per-input mounts, and a writable output mount. Report generation always emits `report.md`, `report.tex`, and a real `report.pdf`; when XeLaTeX is unavailable or the TeX source cannot compile, a built-in PDF renderer is used and `report-status.json` records the limitation.

Every exported `project.zip` is standalone: unpack it anywhere and run `python3 reproduce.py`. The package contains frozen requests/results, committed figures and tables, the Python execution source, a pinned requirements manifest and Dockerfile, and a package manifest; reproduction re-executes every frozen request, verifies semantic results plus artifact hashes, and rebuilds `reproduced/deliverables/report.pdf` without the original repository, application, SQLite database, or run ID.

## Security

Generated code is untrusted. It is policy-checked and executed in a constrained container. Network research is mediated by `ResearchGateway`; browser and model credentials are never written to run state or exported projects.

## License

Apache-2.0. Competition data, papers, and user-provided materials retain their original rights and are not part of this repository.
