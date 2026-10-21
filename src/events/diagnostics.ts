/**
 * A terminal-only error summary. Persistent EventRecorder logs metadata only.
 * Provider failures can contain API keys or oversized, line-broken payloads:
 * bound the displayed size and redact common key patterns.
 */
export function formatDiagnostic(message: string): string {
  const redacted = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-|gsk_)[a-zA-Z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();

  const limit = 900;
  return redacted.length > limit ? redacted.slice(0, limit) + "... [truncated]" : redacted;
}
