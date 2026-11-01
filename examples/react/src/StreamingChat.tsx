import { useEffect, useRef, useState } from "react";
import { client } from "./api";

// Backend contract: SSE data is { delta: string }, followed by data: [DONE].
export default function StreamingChat() {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = undefined;
    },
    [],
  );
  async function send() {
    if (!prompt.trim()) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setAnswer("");
    setError("");
    setStreaming(true);
    try {
      for await (const event of client.stream("/chat", {
        method: "POST",
        body: { message: prompt },
        format: "sse",
        signal: controller.signal,
        timeoutMs: 120_000,
      })) {
        if (active.current !== controller || controller.signal.aborted) break;
        if (event.data === "[DONE]") break;
        if (event.event === "error")
          throw new Error("The chat server reported an error.");
        const payload: unknown = JSON.parse(event.data);
        if (
          !payload ||
          typeof payload !== "object" ||
          !("delta" in payload) ||
          typeof payload.delta !== "string"
        )
          throw new Error("Invalid chat event.");
        const delta = payload.delta;
        setAnswer((value) => value + delta);
      }
    } catch (cause) {
      if (active.current === controller && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Chat failed.");
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        setStreaming(false);
      }
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label>
        Message{" "}
        <input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={streaming}
        />
      </label>
      <button disabled={streaming || !prompt.trim()}>Send</button>
      <button
        type="button"
        disabled={!streaming}
        onClick={() => active.current?.abort()}
      >
        Stop
      </button>
      <p role="status">{streaming ? "Receiving…" : "Ready"}</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{answer}</pre>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
