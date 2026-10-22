import type { AgentEvent } from "../events/event";
import { formatDiagnostic } from "../events/diagnostics";

export type TerminalWriter = {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
};

export type TerminalUIOptions = Readonly<{
  color?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}>;

type Tone = "cyan" | "green" | "yellow" | "red" | "dim" | "bold";
const ansi: Record<Tone, string> = {
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
};

/**
 * Terminal output may contain model-generated text, paths and commands.
 * Remove terminal control codes, not just their ESC prefix: sequences such as
 * OSC clipboard modification and CSI cursor movement must never execute.
 * Keep ordinary newlines and tabs for readable command previews.
 */
export function safeTerminalText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function shouldUseColor(output: TerminalWriter, env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  if (env.FORCE_COLOR === "0") return false;
  return output.isTTY === true || (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "");
}

export class TerminalUI {
  private readonly colors: boolean;
  private streamingText = false;
  private streamEndedWithNewline = true;
  private reportedModelFailureTurnId: string | undefined;

  constructor(private readonly output: TerminalWriter, options: TerminalUIOptions = {}) {
    const env = options.env ?? process.env;
    this.colors = options.color ?? shouldUseColor(output, env);
  }

  private style(text: string, tone: Tone): string {
    const safe = safeTerminalText(text);
    return this.colors ? ansi[tone] + safe + "\u001b[0m" : safe;
  }

  private line(text = ""): void {
    this.output.write(text + "\n");
  }

  private bashExitStatus(output: string): { exitCode: string; timedOut: boolean; truncated: boolean } | undefined {
    const code = /^exit_code: (null|\d+)$/m.exec(output)?.[1];
    if (!code) return undefined;
    return {
      exitCode: code,
      timedOut: /^timed_out: true$/m.test(output),
      truncated: /^output_truncated: true$/m.test(output),
    };
  }

  private closeStreamingText(): void {
    if (this.streamingText && !this.streamEndedWithNewline) this.line();
    this.streamingText = false;
    this.streamEndedWithNewline = true;
  }

  banner(provider: string, cwd: string): void {
    const rule = this.style("────────────────────────────────────────────", "dim");
    this.line();
    this.line(rule);
    this.line("  " + this.style("◆ mini-code-agent", "cyan") + "  " + this.style("v0.4-dev", "dim"));
    this.line("  " + this.style("Model", "dim") + "  " + this.style(provider, "bold"));
    this.line("  " + this.style("Workspace", "dim") + "  " + safeTerminalText(cwd));
    this.line(rule);
    this.line(this.style("  Type a request · exit to quit · Ctrl+C to interrupt", "dim"));
    this.line();
  }

  prompt(): string {
    return this.style("❯ ", "cyan");
  }

  permissionPrompt(): string {
    return this.style("  Approve command? [y/N] ", "yellow");
  }

  approvalRequest(command: string, cwd: string): void {
    this.closeStreamingText();
    const border = this.style("│", "yellow");
    this.line();
    this.line(this.style("╭─ ⚠ Permission required ─────────────────────", "yellow"));
    this.line(border + " " + this.style("Action", "dim") + "     Execute Bash command");
    this.line(border + " " + this.style("Directory", "dim") + "  " + safeTerminalText(cwd));
    this.line(border + " " + this.style("Command", "dim"));
    for (const line of safeTerminalText(command).split("\n")) {
      this.line(border + "   " + this.style(line, "bold"));
    }
    this.line(this.style("╰────────────────────────────────────────────", "yellow"));
    this.line(this.style("  Default: deny. Review the full command before approving.", "dim"));
  }

  approvalResult(allowed: boolean): void {
    this.line(allowed
      ? "  " + this.style("✓ Permission granted", "green")
      : "  " + this.style("⊘ Permission denied — command not approved", "yellow"));
    this.line();
  }

  maxSteps(steps: number): void {
    this.closeStreamingText();
    this.line(this.style("⚠", "yellow") + " Reached step limit (" + steps + ").");
    this.line();
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "turn.started":
        this.reportedModelFailureTurnId = undefined;
        break;
      case "model.request.prepared":
        this.closeStreamingText();
        this.line(this.style("↗ MODEL", "cyan") + " " +
          this.style("~" + event.estimatedTokens + " tokens (estimated) · " +
            event.messageCount + " messages · " + event.toolCount + " tools", "dim"));
        if (event.compacted) {
          this.line(this.style("  ⚠ CONTEXT", "yellow") + " " +
            this.style(event.droppedMessages + " messages compacted or output trimmed", "dim"));
        }
        break;
      case "tool.requested":
        this.closeStreamingText();
        this.line(this.style("  ↗ CALL", "cyan") + " " + this.style(event.toolName, "bold") +
          this.style(" · args: " +
            (event.input && typeof event.input === "object"
              ? Object.keys(event.input).slice(0, 8).join(", ") || "(none)" : "(scalar)"), "dim"));
        break;
      case "tool.output.budgeted":
        this.closeStreamingText();
        this.line(this.style("  ⚠ OUTPUT", "yellow") + " " +
          this.style(event.toolName + " · " + event.originalChars + " → " +
            event.forwardedChars + " chars forwarded to model", "dim"));
        break;
      case "model.started":
        this.closeStreamingText();
        this.line(this.style("◌", "cyan") + " " + this.style("Thinking…", "dim"));
        break;
      case "model.text.delta": {
        if (!this.streamingText) {
          this.line();
          this.line(this.style("◆ Assistant", "cyan"));
          this.streamingText = true;
        }
        const text = safeTerminalText(event.delta);
        this.output.write(text);
        this.streamEndedWithNewline = text.endsWith("\n");
        break;
      }
      case "model.completed":
        this.closeStreamingText();
        if (event.toolCallCount > 0) {
          this.line(this.style("↳", "dim") + " " +
            this.style(event.toolCallCount + " tool request" +
              (event.toolCallCount === 1 ? "" : "s") + " · " + event.durationMs + "ms", "dim"));
        }
        break;
      case "model.rate_limited":
        this.closeStreamingText();
        this.line(this.style("⚠ RATE LIMIT", "yellow") + " " +
          this.style("waiting " + (event.waitMs / 1000).toFixed(2) + "s · retry " +
            event.attempt + "/" + event.maxRetries, "dim"));
        break;
      case "model.failed":
        this.closeStreamingText();
        this.reportedModelFailureTurnId = event.turnId;
        this.line();
        this.line(this.style("✗ Model request failed", "red") +
          " " + this.style("(" + event.durationMs + "ms)", "dim"));
        this.line("  " + this.style(event.error.name + ": ", "red") +
          safeTerminalText(formatDiagnostic(event.error.message)));
        this.line();
        break;
      case "tool.started": {
        this.closeStreamingText();
        const reason = event.queueWaitMs > 0
          ? " · queued " + event.queueWaitMs + "ms" +
            (event.queueReason ? " (" + event.queueReason + ")" : "")
          : "";
        this.line();
        this.line(this.style("↳ RUN", "cyan") + "  " +
          this.style(event.toolName, "bold") + this.style(reason, "dim"));
        break;
      }
      case "tool.completed": {
        this.closeStreamingText();
        // A Bash Tool may finish correctly while its shell command returns
        // nonzero, times out or is truncated. Do not present that as success.
        const shell = event.toolName === "bash"
          ? this.bashExitStatus(event.output)
          : undefined;
        const warning = shell &&
          (shell.exitCode !== "0" || shell.timedOut || shell.truncated);
        const status = warning ? "⚠ FINISHED" : "✓ DONE";
        const detail = shell && warning
          ? " · " + (shell.timedOut ? "timed out" : shell.truncated
            ? "output truncated" : "exit " + shell.exitCode)
          : "";
        this.line(this.style(status, warning ? "yellow" : "green") + " " +
          safeTerminalText(event.toolName) + this.style(detail, warning ? "yellow" : "dim") +
          this.style(" · " + event.durationMs + "ms", "dim"));
        break;
      }
      case "tool.failed":
        this.closeStreamingText();
        this.line(this.style("✗ TOOL ERROR", "red") + " " +
          safeTerminalText(event.toolName) + " " +
          this.style("· " + event.durationMs + "ms", "dim"));
        this.line("  " + safeTerminalText(formatDiagnostic(event.error.message)));
        break;
      case "turn.completed":
        this.closeStreamingText();
        this.line();
        this.line(this.style("✓ Completed", "green"));
        this.line();
        break;
      case "turn.aborted":
        this.closeStreamingText();
        this.line();
        this.line(this.style("⊘ Interrupted", "yellow") + "  " +
          safeTerminalText(formatDiagnostic(event.reason)));
        this.line();
        break;
      case "turn.failed":
        this.closeStreamingText();
        if (this.reportedModelFailureTurnId !== event.turnId) {
          this.line();
          this.line(this.style("✗ Turn failed", "red"));
          this.line("  " + this.style(event.error.name + ": ", "red") +
            safeTerminalText(formatDiagnostic(event.error.message)));
        } else {
          this.line(this.style("✗ Turn stopped", "red") + this.style(" · see model error above", "dim"));
        }
        this.line();
        break;
    }
  }
}
