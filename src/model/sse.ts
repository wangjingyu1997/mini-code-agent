export async function* parseSseJson(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("SSE stream aborted");
      }

      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (data && data !== "[DONE]") {
          yield JSON.parse(data) as unknown;
        }

        boundary = buffer.indexOf("\n\n");
      }

      if (done) {
        break;
      }
    }

    const tail = buffer.trim();
    if (tail) {
      const data = tail
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      if (data && data !== "[DONE]") {
        yield JSON.parse(data) as unknown;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
