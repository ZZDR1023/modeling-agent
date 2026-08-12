# Modeling Agent

[![CI](https://github.com/ZZDR1023/modeling-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/ZZDR1023/modeling-agent/actions/workflows/ci.yml)

`modeling-agent` 是一个在本地运行、面向数学建模竞赛的单用户智能体。它会读取题目材料包，把全部要求分解为带类型的任务图，运行真实且可复现的 Python 实验，记录从结论到证据的追踪关系，并导出一个完整、可复现的项目包。

当前目标版本是 `v0.1-alpha`：以明确的证据等级，尽力覆盖常见任务族。当前版本并不成熟；这既不意味着它能可靠解决所有建模问题，也不代表具备获奖级表现。在缺少基准测试证据时，不应作出成熟或获奖级能力声明。

## 架构

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

外层生命周期固定不变。规划器通过 Schema 约束生成内部任务图；任务族共 9 类：

- 统计分析
- 回归与预测
- 时间序列预测
- 分类
- 聚类
- 评价与排序
- 优化
- 仿真
- 面向长尾方法的实验性兜底任务

## 开发状态

本仓库目前按纵向切片方式开发。[alpha 规格](docs/spec/v0.1-alpha.md)说明已冻结的功能边界，[两周实施计划](docs/spec/two-week-plan.md)列出对应里程碑。

## 前置条件

- Node.js 24 LTS
- Python 3.11
- Docker
- 用于生成中文报告、带 CTeX 的 XeLaTeX
- 用于受审计网络研究的 OpenCLI

## 完整命令

```bash
npm ci
npm run check
npm run cli -- run ./tests/fixtures/basic --runtime fake --execution local
npm run cli -- list
npm run cli -- show <run-id>
npm run cli -- export <run-id> ./project.zip
npm run cli -- reproduce <run-id>
```

如需选择独立的运行数据库与工作区，请在子命令前传入 `--runs-root <path>`；如需机器可读输出，请给相应子命令添加 `--json`。fake runtime 是确定性的测试实现；pi SDK runtime 仍为可选能力，并通过 `AgentRuntime` 接口与其余系统隔离。

## 执行与报告契约

本地执行路径是当前 alpha 阶段支持的基线。若要使用 Docker，请先运行 `docker build -t modeling-agent-python:0.1-alpha python/` 构建固定版本的 worker 镜像，再设置 `MODELING_AGENT_PYTHON_IMAGE=modeling-agent-python:0.1-alpha`，或传入等效的 worker 选项。

Docker 执行采用 Python 模块调用，并遵守以下安全契约：容器不能访问网络；根文件系统只读；CPU、内存等资源受限；每个输入以只读方式挂载；只有输出挂载点可写。报告生成始终产出 `report.md`、`report.tex` 和真实的 `report.pdf`。如果 XeLaTeX 不可用或 TeX 源文件编译失败，系统会改用内置 PDF 渲染器，并在 `report-status.json` 中记录明确的兜底告警与限制，而不会静默掩盖降级。

## 独立复现包

每个导出的 `project.zip` 都是独立可复现的软件包：可以在任意目录解压，然后运行 `python3 reproduce.py`。项目包包含冻结的请求与结果、已提交的图表、Python 执行源码、固定依赖清单与 Dockerfile，以及包清单。

复现流程会重新执行每个冻结请求，校验语义结果和产物哈希，并在 `reproduced/deliverables/report.pdf` 重建报告；整个过程不依赖原始仓库、应用程序、SQLite 数据库或 run ID。

## 安全边界

生成的代码一律视为不可信内容：只有通过策略校验后，才能在受资源限制的容器中执行。网络研究统一由 `ResearchGateway` 代理；浏览器凭据和模型凭据绝不会写入运行状态，也不会进入导出的项目包。LLM 输出本身不能充当证据，数值结论必须能通过 Evidence Graph 解析到实际证据。

## 许可证与材料版权

本仓库代码采用 Apache-2.0 许可证。竞赛数据、论文及用户提供的其他材料继续归各自权利人所有，不属于本仓库的授权内容。
