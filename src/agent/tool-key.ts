export function stableKey(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableKey).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((key) => JSON.stringify(key) + ":" + stableKey(obj[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "undefined";
}

export function toolRequestKey(name: string, input: unknown): string {
  return name + ":" + stableKey(input);
}
