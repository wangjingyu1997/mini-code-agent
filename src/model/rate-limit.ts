import { setTimeout as sleep } from "node:timers/promises";

const MAX_WAIT_MS = 30_000;

function parseSeconds(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const numeric = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(numeric) && numeric >= 0) {
    return numeric * 1000;
  }
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

/**
 * Choose an abortable 429 retry delay, favoring explicit provider hints over
 * bounded exponential fallback. The hint can appear in a Retry-After header
 * or in Groq's "Please try again in 1.53s" error body.
 */
export function rateLimitWaitMs(
  response: Response,
  detail: string,
  retriesSoFar: number,
): number {
  const hinted = parseSeconds(response.headers.get("retry-after"));
  const match = /please try again in\s+(\d+(?:\.\d+)?)\s*s\b/i.exec(detail);
  const bodyHint = match ? Number(match[1]) * 1000 : undefined;
  const fallback = Math.min(MAX_WAIT_MS, 1_000 * 2 ** retriesSoFar);
  const wait = hinted ?? (bodyHint !== undefined && Number.isFinite(bodyHint) ? bodyHint : fallback);
  // Add a small safety margin to provider-advised nonzero waits.
  return Math.min(MAX_WAIT_MS, Math.ceil(wait > 0 ? wait + 100 : 0));
}

export async function waitForRateLimit(waitMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("Rate-limit wait aborted");
  try {
    await sleep(waitMs, undefined, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw error;
  }
}
