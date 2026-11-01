import { abortable } from "./callbacks";
import { ApiError } from "./errors";
import type { ServerSentEvent } from "./types";

/** One reader, no background queue or reconnects. Consumers control backpressure. */
export async function* readStream(
  response: Response,
  signal: AbortSignal,
  assert: () => void,
  format: "text" | "sse",
  maxSize: number,
): AsyncGenerator<string | ServerSentEvent, void, unknown> {
  assert();
  const reader = response.body?.getReader();
  if (!reader) {
    if (response.status === 204 || response.status === 205) return;
    throw new ApiError(
      "Response has no readable body",
      response.status,
      {},
      undefined,
      "parse",
    );
  }
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let line = "",
    skipLF = false,
    data = "",
    hasData = false,
    event = "",
    id = "";
  let retry: number | undefined;
  function tooLarge() {
    throw new ApiError(
      "SSE line or event exceeds maxEventSize",
      response.status,
      {},
      undefined,
      "parse",
    );
  }
  function finishLine(): ServerSentEvent | undefined {
    const value = line;
    line = "";
    if (!value) {
      const result = hasData
        ? Object.freeze({
            event: event || "message",
            data: data.slice(0, -1),
            id,
            ...(retry === undefined ? {} : { retry }),
          })
        : undefined;
      data = "";
      hasData = false;
      event = "";
      return result;
    }
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") {
      if (data.length + content.length + 1 > maxSize) tooLarge();
      data += content + "\n";
      hasData = true;
    } else if (field === "event") event = content;
    else if (field === "id" && !content.includes("\0")) id = content;
    else if (
      field === "retry" &&
      /^\d+$/.test(content) &&
      Number.isSafeInteger(Number(content))
    )
      retry = Number(content);
    return undefined;
  }
  try {
    assert();
    if (
      format === "sse" &&
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase() !== "text/event-stream"
    )
      throw new ApiError(
        "Expected text/event-stream response",
        response.status,
        {},
        undefined,
        "parse",
      );
    while (true) {
      const part = await abortable(() => reader.read(), signal);
      assert();
      const text = part.done
        ? decoder.decode()
        : decoder.decode(part.value, { stream: true });
      if (format === "text") {
        if (text) {
          assert();
          yield text;
          assert();
        }
      } else {
        for (const character of text) {
          assert();
          if (skipLF) {
            skipLF = false;
            if (character === "\n") continue;
          }
          if (character === "\r" || character === "\n") {
            skipLF = character === "\r";
            const message = finishLine();
            if (message) {
              assert();
              yield message;
            }
          } else {
            if (line.length + character.length > maxSize) tooLarge();
            line += character;
          }
        }
      }
      // SSE requires a blank line to dispatch; an incomplete final event is discarded.
      if (part.done) break;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
