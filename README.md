# mini-code-agent

A production-oriented Coding Agent built incrementally in TypeScript.

这个仓库同时是 Agent 工程化课程的长期实战仓库。每次课程都会同步代码，并在本 README 的「学习记录」中记录本次目标、实现、验证结果和下一步。

## Current version

`v0.4-dev` — Groq Provider + Patch Engine + approval-gated Bash Tool

## V0.3 capabilities

- Session / Turn / Step runtime
- Provider-independent `Model` interface
- OpenAI Responses API streaming adapter
- Tool JSON Schema exposed to the model
- Complete `function_call -> function_call_output` causal history
- `Tool.plan(input, context)` execution planning contract
- Resource Claims with `read` / `write` access modes
- Resource conflict detection
- Bounded tool concurrency via `maxConcurrency`
- FIFO fairness for contended resources
- Dynamic admission: newly-safe work starts as soon as running work completes
- Deterministic result join in original model call order
- Conservative global workspace claim when planning fails
- `AbortSignal` propagation through model, scheduler and tool execution

## Run

### Mock provider

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

### Groq provider (recommended for current development)

Create a key at https://console.groq.com/keys and set:

```dotenv
MODEL_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-120b
```

Then run:

```bash
pnpm test
pnpm dev:env
```

Try: `读取 package.json，并解释 scripts 的作用`.

Groq uses its OpenAI-compatible Responses API; the existing
`OpenAIResponsesModel` handles streaming and tool calls. No code changes
to `TurnRunner` or `ToolScheduler` are required.

Keep keys only in your ignored `.env` file. Groq's Responses API is in beta;
a successful non-streaming API request does not by itself validate streamed
function calling. Verify the full model -> tool -> model loop with your key.

### Bash execution (approval required)

The CLI now registers `bash` alongside `read_file`, `list_files`, and
`apply_patch`. Ask the Agent to run `git status` or `pnpm test`. It will
show the exact command and require `y` or `yes` before execution.
Any other answer denies the command.

Commands run with the project as their working directory, a default
120-second deadline, and a combined stdout/stderr capture limit of 64 KiB.
Nonzero exit codes are returned to the model with stderr so it can diagnose
failures. Commands use the Bash shell and currently target macOS/Linux.

**Security:** This is an approval gate, NOT an OS sandbox. A confirmed shell
command can read or modify files outside the workspace, access the network,
and run arbitrary programs with your account permissions. Review commands
carefully; do not approve commands that print secrets or your local `.env`.
The tool removes common credential-like environment variables before
spawning child processes, and `read_file` blocks typical secret files, but
neither defense is complete. Use a disposable repository for early trials.
Future versions will add policy-driven approvals and real isolation.

### Local observability (metadata-only)

The CLI logs model-step duration, tool execution duration, and Scheduler queue
wait time to the terminal. Every execution also records privacy-conscious
metadata to:

```text
.mini-code-agent/logs/events.jsonl
```

The directory is ignored by Git. Each line is a JSON object with `type`,
`sessionId`, `turnId`, `stepId` (when relevant), timestamp, and selected
metrics. The recorder **does not persist prompts, model text deltas, tool
inputs, tool outputs, or exception messages/stacks**, because they can contain
secrets. This file is for troubleshooting metrics, not session replay.
It currently writes metadata asynchronously in the background and flushes at
normal CLI shutdown; an OS crash can lose unwritten records.

Try:

```bash
pnpm test
pnpm dev:env
# After you exit the CLI:
tail -n 20 .mini-code-agent/logs/events.jsonl
```

Example event:

```json
{"version":1,"type":"tool.started","at":0,"sessionId":"s","turnId":"t","stepId":"step","callId":"call-1","toolName":"bash","queueWaitMs":12,"queueReason":"resource_conflict"}
```

Queue reasons report the **last observed** admission blocker, not a detailed
history of every conflict. Token counts / provider API usage and approval
decisions are not yet captured. SQLite session persistence and searchable
run history remain future work.

### OpenAI provider

```bash
cp .env.example .env
```

Configure:

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=your_model_name_here
```

Then run:

```bash
pnpm dev:env
```

API keys must stay in `.env`; `.env` is ignored by Git.

## Architecture

```text
CLI
  -> AgentRuntime
    -> TurnRunner
      -> Model
         -> MockModel
         -> OpenAIResponsesModel
              -> HTTP POST /v1/responses
              -> SSE stream
              -> Provider event normalization
      -> ToolScheduler
         -> ExecutionPlan / ResourceClaim
         -> conflict detection
         -> maxConcurrency / fairness / cancellation
      -> ToolOrchestrator
         -> validation / preparation / execution / events
      -> ToolRegistry
         -> Tool
      -> EventBus / EventStore
```

The core separation is now:

```text
TurnRunner      decides which model step we are in
ToolScheduler   decides WHEN a prepared tool call may start
ToolOrchestrator decides HOW one tool call is prepared and executed
Tool            performs the domain operation
```

## Important runtime flow

```text
UserMessage
   -> Model.stream()
      -> text.delta
      -> one or more ToolCall
   -> TurnRunner
      -> AssistantToolCallMessage
      -> ToolScheduler.executeBatch()
         -> Tool.plan()
         -> ResourceClaim conflict checks
         -> bounded concurrent execution
      -> ToolOrchestrator
      -> ToolMessage[]
   -> results re-joined in original ToolCall order
   -> next Model step
```

## Resource model

V0.3 intentionally starts with a small resource model:

```text
ResourceClaim = {
  key: string
  access: "read" | "write"
}
```

Conflict rule:

```text
R + R -> no conflict
R + W -> conflict
W + R -> conflict
W + W -> conflict
```

`workspace:*` is a conservative global resource. A tool whose resource plan cannot be trusted can claim it and serialize against all workspace work.

This version uses canonical lexical workspace paths. More precise hierarchical resource modeling, patch-file version checks and external-world concurrency are deferred to the Patch Engine phase.

## Roadmap

- `v0.1` Agent Kernel: Session / Turn / Step, EventBus, MockModel, basic tools ✅
- `v0.2` Real LLM adapter + streaming tool calls ✅
- `v0.3` Tool Scheduler + bounded concurrency + resource claims ✅
- `v0.4` Patch Engine + optimistic concurrency ✅ (initial single-file implementation)
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
2. 区分 `Session / Turn / Step` 生命周期，避免把所有运行时语义塞进一个巨大循环。
3. 使用 `AsyncIterable<ModelEvent>` 作为模型接口，为流式文本、Tool Call 和取消传播预留稳定契约。
4. 建立 `EventBus + InMemoryEventStore`，把 Runtime state 与对外事件观察分开。
5. 建立 `ToolRegistry + ToolOrchestrator`，把 Tool domain operation 与 Runtime orchestration 分开。
6. 实现 `read_file`、`list_files`，加入 workspace path boundary 和 symlink escape 检查。
7. Tool 从 V0.1 开始接收 `AbortSignal`。
8. 使用 deterministic `MockModel` 先验证 deterministic runtime correctness。

**核心认识**

Coding Agent 的主体不是一次 LLM API 调用，而是围绕模型构建的可观察、可中断、可扩展 Runtime。LLM 负责下一步决策，Runtime 负责状态正确性和执行边界。

---

### 2026-10-13 — V0.2 Real LLM Provider + Streaming Tool Calling

**目标**

在不破坏 `TurnRunner` 核心控制流的前提下，引入真实模型 Provider，并把 HTTP / SSE / Provider event / function-call correlation 隔离在 Adapter 边界。

**本次实现**

1. 新增 `src/contracts/tool.ts`，把 ToolCall / ToolDefinition 提升为 Runtime shared contract。
2. Tool 增加 description / JSON Schema，真实模型可以发现工具和参数结构。
3. Session 新增 `assistant_tool_call`，保存完整 `function_call -> function_call_output` 因果链。
4. 新增 OpenAI Responses API Adapter，使用原生 `fetch + SSE`。
5. 将 Provider-specific streaming events 归一化成内部 `ModelEvent`。
6. 按 `item_id` 缓冲 function arguments delta，完成后才解析 JSON。
7. 支持同一 Response 中多个 Tool Call 交错 streaming，并用 `call_id` 关联 Tool Result。
8. `AbortSignal` 真正进入 HTTP request。
9. 修正 CLI EOF 与 Node test command 的真实运行问题。

**核心认识**

Provider Adapter 不是简单 API wrapper，而是 Anti-Corruption Layer：外部模型协议不能泄漏进 Agent Runtime。

**验证结果**

```text
TypeScript build: PASS
Automated tests: 8/8 PASS
Mock CLI two-step Agent Loop: PASS
```

---

### 2026-10-14 — V0.3 Tool Scheduler + Resource Claims

**目标**

真实模型现在可以在一个 Step 中生成多个 Tool Call。V0.2 仍然通过 `for (...) await execute(...)` 串行执行，因此今天正式建立 Tool Scheduling 层，解决安全并发、资源冲突、背压、公平性、取消和确定性结果归并。

**从 Codex 学到的设计线索**

当前 Codex 的 Tool Runtime 让 Tool 声明自己是否支持 parallel tool calls，默认不支持；其运行时使用 shared/exclusive gate 让 parallel-safe 调用共享执行，而非 parallel 调用获得独占执行权。我们的 V0.3 保留“并发能力属于 Tool Contract，而不是 Scheduler 硬编码工具名”这个原则，但进一步把 boolean 扩展成动态 `ExecutionPlan + ResourceClaim`。

**本次实现**

1. `Tool` 新增 `plan(input, context): ExecutionPlan`。
2. 新增 `ResourceClaim { key, access }`，access 为 `read | write`。
3. 新增 `ExecutionPlan`，同时描述资源、side effect 和 risk。
4. 新增 `workspacePathResource()`，将 Tool input 映射成 canonical lexical workspace resource key。
5. 新增 `workspace:*` conservative global claim；未知工具、参数验证失败或无法安全规划时不会乐观并发，而是保守串行。
6. `ToolOrchestrator` 拆成 `prepare()` 与 `executePrepared()`：先 validation + planning，再由 Scheduler 决定何时执行。
7. 新增 `ToolScheduler.executeBatch()`，从 TurnRunner 接收一个 Model Step 产生的整个 ToolCall batch。
8. Scheduler 允许 `read/read` 并发，阻止同资源上的 `read/write`、`write/read`、`write/write`。
9. 新增 `maxConcurrency`，即使 100 个调用互不冲突也不会无限并发，形成 backpressure。
10. Scheduler 不是静态分批；任一 running task 完成后会立即重新 drain queue，让新近变得安全的任务马上启动。
11. 加入 per-resource FIFO fairness：一个 waiting writer 前面仍有 reader 时，后来的 reader 不能持续越过 writer，避免 writer starvation；不相关资源仍可继续执行。
12. Tool 实际完成顺序可以乱序，但 Scheduler 最终按原始 Model ToolCall index 返回结果，Session history 因而保持 deterministic logical order。
13. TurnRunner 从逐个 `await this.tools.execute()` 改成一次 `scheduler.executeBatch()`。
14. `AbortSignal` 进入 Scheduler；abort 时停止继续 admission，并把同一个 signal 传给已运行 Tool。
15. `read_file` / `list_files` 现在都声明自己的 read resource plan。

**为什么不用 `Promise.all(toolCalls.map(execute))`**

因为 `Promise.all` 只解决并发，不解决正确性。它不知道两个 Tool 是否访问同一资源，也没有并发上限、公平性、排队语义或取消 admission。Scheduler 本质上是一个小型 admission-control system。

**V0.3 冲突模型**

```text
read(file:a)  + read(file:a)   -> parallel
read(file:a)  + read(file:b)   -> parallel
read(file:a)  + write(file:a)  -> serialize
write(file:a) + write(file:a)  -> serialize
workspace:* write + any workspace claim -> serialize
```

**公平性例子**

```text
R1(file:a) running
W (file:a) waiting
R2(file:a) later
R3(file:b) later
```

允许 `R3` 继续，因为与 writer 无关；阻止 `R2` 越过 `W`，否则持续到来的 reader 可能让 writer 永远拿不到执行机会。

**验证结果**

V0.3 核心回归 harness 已验证：

```text
Core TypeScript compile: PASS
Runtime / Tool / Scheduler tests: 11/11 PASS
```

新增 Scheduler 行为测试覆盖：

- independent reads concurrent
- same-resource read/write serialization
- bounded `maxConcurrency`
- completion order != logical result order
- waiting-writer fairness
- cancellation of queued scheduling work

OpenAI Provider Adapter 代码和其原有 3 个测试本次未修改；在本地拉取仓库后请执行 `pnpm test` 做完整项目回归。

**核心认识**

Tool Scheduler 不负责“工具怎么执行”，而负责“工具什么时候可以执行”。真正可演进的并发模型必须让 Tool 暴露资源意图，让 Scheduler 只理解通用 ExecutionPlan，而不是理解具体工具名。

**下一课（V0.4）**

进入 Patch Engine + Optimistic Concurrency。Scheduler 只能协调经过本进程的 Tool；它无法阻止用户在 VSCode、另一个进程或另一个 Agent 同时修改文件。下一步会实现 snapshot hash、stale-file detection、preflight、hunk matching、atomic single-file write、multi-file transaction-like commit 与 rollback。
---

### 2026-10-19 — Groq Provider Integration

**目标**

接入可用于真实 Coding Agent 开发的 Groq 免费层，复用已经实现的
OpenAI Responses Adapter，不将供应商协议泄漏到 Agent Runtime。

**本次实现**

1. `createModelFromEnv` 支持 `MODEL_PROVIDER=groq`，默认模型 `openai/gpt-oss-120b`。
2. 使用 `https://api.groq.com/openai/v1` 作为 Responses API baseUrl。
3. 更新 `.env.example`，增加 Provider 工厂测试。
4. 已通过 Groq 非流式 Responses API 手动验证模型可访问；真实 SSE Tool Calling
   尚需在本机使用 `pnpm dev:env` 进行端到端验证。

**设计决定**

复用现有 `Model.stream()` 接口和 Provider Adapter；不因新增供应商而修改
`TurnRunner`、`ToolScheduler` 或工具执行链路。

**下一步**

1. 本机运行 `pnpm test` 并用 Groq 测试完整 Tool Calling 闭环。
2. 实现具备审批、超时、取消及输出限额的 Bash Tool，进入真实编程工作流。

---

### 2026-10-19 — Bash Tool / First Real Coding Workflow

**目标**

从教学型 Agent Loop 转向可用于实际开发的 CLI Coding Agent：让模型能够在人工许可后
执行 shell 命令、读取测试结果，并继续修复代码。

**本次代码**

1. 新增 `src/tools/tools/bash.ts`，用 `spawn("bash", ["-c", command])` 执行。
2. 每条模型生成的命令都需要 CLI 交互确认；拒绝时不执行。
3. 将 Bash 声明为保守的 `workspace:*` 写资源，避免与其他 workspace tool 并发。
4. 输出 stdout/stderr、退出码、超时状态及截断状态；设置默认超时和输出限额。
5. 接入 AbortSignal，尝试终止子进程组，并在 1 秒后升级为 SIGKILL。
6. 防止常见凭证环境变量自动传给子进程，并阻止 `read_file` 读取常见 secret 文件。
7. 新增 `tests/bash.test.ts` 行为测试，包括拒绝、非零退出码、超时、取消、截断和环境变量保护。
8. 新增 GitHub Actions CI：push / pull request 时执行 TypeScript build 和测试。

**需要本机验证**

```bash
git pull --ff-only
pnpm test
pnpm dev:env
```

在 CLI 中输入：`请运行 git status，并说明工作区是否干净`。执行前会要求确认。
**代码已提交，自动测试和 Groq + bash 端到端体验尚未在本地运行验证。**

**后续重点**

引入用户可配置的审批策略、真正的 sandbox / 进程隔离、持久化会话、
上下文压缩，以及基于真实仓库任务的 Agent 成功率测试。

---

### 2026-10-20 — Observability V1: metrics + safe JSONL

**本次目标**

把已经具备的事件系统转变成可供实际调试 Coding Agent 的运行轨迹，
而不是只在终端打印工具开始与结束。

**实现**

1. 新增 `model.completed` / `model.failed` 事件，记录 Step 耗时、文本长度和 ToolCall 数。
2. `tool.started` 增加 Scheduler 排队等待时间与最后一个阻塞原因。
3. `tool.completed` / `tool.failed` 增加执行耗时。
4. 新增 `JsonlEventRecorder`：元数据白名单、异步顺序写入、正常关闭时 flush。
5. 默认写入 `.mini-code-agent/logs/events.jsonl`，通过 `.gitignore` 排除。
6. 新增日志脱敏、写入失败、Scheduler 排队、Runtime 生命周期测试。

**安全边界**

原始用户输入、模型文本、工具参数和工具输出可能包含源码或凭证，
因此不得直接 JSON 序列化完整 `AgentEvent` 到诊断日志。
本次只持久化明确允许的指标字段。

**本地验证**

运行 `pnpm test`、`pnpm dev:env`；结束交互后检查 JSONL。
本次改动已提交 GitHub，仍需确认 CI / 本地测试结果及 Groq 真实端到端行为。

**后续**

- 补齐模型 Token 用量、审批结果与安全事件。
- 会话恢复时引入 SQLite，并明确区分可靠会话存储与最佳努力诊断日志。
- 增加运行汇总统计（耗时分布、成功率、失败归因），不急于引入独立日志服务。
