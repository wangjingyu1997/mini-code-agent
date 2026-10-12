# mini-code-agent

A production-oriented Coding Agent built incrementally in TypeScript.

这个仓库同时是 Agent 工程化课程的长期实战仓库。每次课程都会同步代码，并在本 README 的「学习记录」中记录本次目标、实现和下一步。

## Current version

`v0.1.0` — Agent Kernel baseline

## V0.1 goals

- Session / Turn separation
- Event stream and event store
- Deterministic `MockModel`
- Tool registry + orchestrator
- `read_file` and `list_files`
- Cancellation via `AbortSignal`
- CLI + automated tests

## Run

```bash
pnpm install
pnpm test
pnpm dev
```

Try:

```text
读取 package.json
列出当前目录文件
```

## Architecture

```text
CLI
  -> AgentRuntime
    -> TurnRunner
      -> Model.stream()
      -> ToolOrchestrator
         -> ToolRegistry
         -> Tool
      -> EventBus / EventStore
```

V0.1 deliberately uses a deterministic `MockModel`. V0.2 will replace it with a real streaming model adapter without changing the runtime contract.

## Roadmap

- `v0.1` Agent Kernel: Session / Turn / Step, EventBus, MockModel, basic tools
- `v0.2` Real LLM adapter + streaming tool calls
- `v0.3` Tool Scheduler + bounded concurrency + resource claims
- `v0.4` Patch Engine + optimistic concurrency
- `v0.5` Permission + Sandbox
- `v0.6` Workspace / Git integration
- `v0.7` Codebase Intelligence: AST / symbols / repo map
- `v0.8` Context compaction
- `v0.9` Autonomous coding loop
- Later: API service, PostgreSQL, Redis, queue/workers, transactions, high concurrency, observability and production deployment

## 学习记录

### 2026-10-12 — V0.1 Agent Kernel

**目标**

把前面关于 Coding Agent Runtime 的架构讨论落到一个真实、可运行、可测试的 TypeScript 仓库里，建立后续所有课程共同演进的代码基线。

**本次实现**

1. 建立 `AgentRuntime -> TurnRunner -> Model -> Tool -> Observation -> Next Step` 的最小 Agent Loop。
2. 区分 `Session / Turn / Step` 生命周期，避免把所有运行时语义塞进一个巨大 `while` 循环。
3. 使用 `AsyncIterable<ModelEvent>` 作为模型接口，为真实模型的流式文本、流式 Tool Call 和取消传播预留稳定契约。
4. 建立 `EventBus + InMemoryEventStore`，让 CLI、日志、未来的 Web UI / Telemetry 可以通过事件观察 Runtime，而不是读取内部可变状态。
5. 建立 `ToolRegistry + ToolOrchestrator`，把“工具具体做什么”和“工具如何被 Runtime 调度执行”分开。
6. 实现 `read_file`、`list_files`，并加入 workspace 路径边界与 symlink escape 检查。
7. 从 V0.1 开始让 Tool 接收 `AbortSignal`，后续 shell / network 工具可以把取消继续传播到底层资源。
8. 使用确定性的 `MockModel` 隔离 probabilistic model behavior，先验证 deterministic runtime correctness。
9. 增加自动化测试，覆盖两步 Agent Loop、取消、正常文件读取、workspace escape、防止目录枚举非确定性。

**核心认识**

Coding Agent 的主体不是一次 LLM API 调用，而是围绕模型构建的可观察、可中断、可扩展 Runtime。LLM 负责下一步决策，Runtime 负责状态正确性和执行边界。

**下一课（V0.2）**

接入真实 LLM Provider Adapter，并实现 streaming text / streaming tool-call assembly。重点处理 provider abstraction、tool arguments delta、半包 JSON、多个 tool calls、cancel propagation，以及如何保证 `TurnRunner` 不依赖具体模型供应商。
