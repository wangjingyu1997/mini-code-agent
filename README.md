# mini-code-agent

A production-oriented Coding Agent built incrementally in TypeScript.

这个仓库同时是 Agent 工程化课程的长期实战仓库。每次课程都会同步代码，并在本 README 的「学习记录」中记录本次目标、实现、验证结果和下一步。

## Current version

`v0.2.0` — Real LLM Provider + Streaming Tool Calling

## V0.2 capabilities

- Session / Turn / Step runtime from V0.1
- Provider-independent `Model` interface
- Deterministic `MockModel` remains available for runtime tests
- OpenAI Responses API adapter using native `fetch`
- Raw SSE parsing
- Streaming text normalization
- Interleaved function-call argument buffering by `item_id`
- Multiple tool calls in one model step
- Tool JSON Schema exposed from Tool Registry to the model
- Complete `function_call -> function_call_output` causal history
- `AbortSignal` propagated into the HTTP request and tool execution
- Non-2xx provider error propagation
- CLI provider selection through environment variables
- Automated runtime / tool / provider adapter tests

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

### OpenAI provider

Copy the example environment file:

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
      -> ToolOrchestrator
         -> ToolRegistry
         -> Tool
      -> EventBus / EventStore
```

The runtime does not know whether the model is Mock or OpenAI. Provider-specific streaming details stop at the Model adapter boundary.

## Important runtime flow

```text
UserMessage
   -> Model.stream()
      -> text.delta
      -> function-call argument deltas
      -> completed ToolCall
   -> TurnRunner
      -> AssistantToolCallMessage
      -> ToolOrchestrator
      -> ToolMessage
   -> next Model step
```

The session stores both the assistant's tool-call request and the tool result. This preserves the causal relationship needed by real model APIs.

## Roadmap

- `v0.1` Agent Kernel: Session / Turn / Step, EventBus, MockModel, basic tools
- `v0.2` Real LLM adapter + streaming tool calls ✅
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

---

### 2026-10-13 — V0.2 Real LLM Provider + Streaming Tool Calling

**目标**

在不破坏 `TurnRunner` 核心控制流的前提下，把确定性的 `MockModel` 扩展为可切换的真实模型 Provider，并把 HTTP/SSE、流式文本、流式函数参数、多 Tool Call、工具 Schema 和 Provider 错误封装在 Adapter 边界内。

**真实接入暴露出的 V0.1 缺口**

1. V0.1 的 Session 只记录了 Tool Result，却没有记录 Assistant 发起 Tool Call 的事实；真实 API 需要完整的 `function_call -> function_call_output` 因果链。
2. V0.1 的 Tool Contract 没有 description / JSON Schema，因此真实模型不知道有哪些工具以及参数格式。
3. Provider 的函数参数不是一次性 JSON，而可能以多个字符串 delta 交错流入；不能对每个半包直接 `JSON.parse`。
4. 多个 Tool Call 可以在同一 Response 中交错 streaming，必须通过 `item_id` 做 correlation，再通过 `call_id` 与工具结果关联。
5. 原来的 Node test script 使用目录路径，在当前 Node 22 环境下无法直接运行，改成显式 `dist/tests/*.test.js`。
6. CLI 使用 `readline.question()` 时对 stdin EOF 不够健壮，改为 async iterator，使交互式终端和管道输入都能正常结束。

**本次实现**

1. 新增 `src/contracts/tool.ts`，把 `ToolCall` / `ToolDefinition` 从具体 Model Provider 中抽离成共享 Runtime Contract。
2. Tool 增加 `description` 与 `inputSchema`；`ToolRegistry` 可以导出工具定义给模型。
3. `ModelRequest` 新增 `tools`，但 `TurnRunner` 仍只依赖抽象 `Model`，不知道 OpenAI 的事件格式。
4. Session 新增 `assistant_tool_call` message，保存模型调用工具时的 `callId / toolName / input`。
5. 新增 `OpenAIResponsesModel`：使用 Node 原生 `fetch` 调用 `/v1/responses`，并传递 `AbortSignal`。
6. 新增 SSE parser，把网络字节流恢复成 provider event stream。
7. Adapter 把 `response.output_text.delta` 归一化为内部 `text.delta`。
8. Adapter 按 `item_id` 缓冲 `response.function_call_arguments.delta`；只在函数参数完成后解析完整 JSON，避免半包 JSON 错误。
9. Adapter 支持同一 Response 中多个函数调用交错到达，并将 OpenAI `call_id` 归一化为内部 ToolCall ID。
10. Provider API 的 4xx/5xx 和 streaming error 会向 Runtime 明确传播，而不是被伪装成正常回答。
11. 新增 `createModelFromEnv()`，CLI 可用 `MODEL_PROVIDER=mock|openai` 切换 Provider。
12. 新增 `.env.example`，API key 不进入仓库。
13. 新增 OpenAI Adapter 单元测试；全部测试达到 8/8 通过。

**为什么不直接使用 SDK**

这一课刻意使用原生 `fetch + SSE`，目的是理解 Provider Adapter 真正承担的职责。后续即便替换成官方 SDK，`TurnRunner`、Session、ToolOrchestrator 的架构边界仍然保持不变。

**核心认识**

Provider Adapter 不是简单的“API 包装器”。它实际上是一个协议边界：负责把供应商特有的 HTTP、SSE、事件类型、function-call correlation 和错误模型，归一化成 Agent Runtime 能理解的稳定事件协议。

**验证结果**

```text
TypeScript build: PASS
Automated tests: 8/8 PASS
Mock CLI two-step Agent Loop: PASS
```

**下一课（V0.3）**

实现 Tool Scheduler。真实模型现在可以一次产生多个 Tool Call，下一步必须回答：哪些工具可以并行？哪些必须串行？如何限制并发数量？如何用 Resource Claim 表达 read/write 冲突？如何处理 cancellation、fairness、backpressure 和 deterministic result join？
