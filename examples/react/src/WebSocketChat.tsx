import { useEffect, useState } from "react";
import { createSocketClient } from "universal-api-layer/websocket";
import {
  useSocketMessage,
  useSocketState,
} from "universal-api-layer/websocket/react";
import { client } from "./api";

// Supply a raw WebSocket backend for this development URL; use wss:// in production.
export default function WebSocketChat() {
  const [socket] = useState(() =>
    createSocketClient({
      url: "ws://localhost:3000/chat",
      sessionClient: client,
      requiresAuth: false,
      schema(value: unknown) {
        if (
          !value ||
          typeof value !== "object" ||
          !("text" in value) ||
          typeof value.text !== "string"
        )
          throw Error("Expected a chat message");
        return { text: value.text };
      },
    }),
  );
  const state = useSocketState(socket);
  const [messages, setMessages] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  useSocketMessage(socket, (message) =>
    setMessages((old) => [...old.slice(-99), message.text]),
  );
  useEffect(() => {
    socket.connect();
    return () => socket.disconnect();
  }, [socket]);
  useEffect(
    () =>
      client.subscribeSession(() => {
        setMessages([]);
      }),
    [],
  );
  return (
    <section>
      <p role="status">
        {state.status} (retries: {state.reconnectAttempt})
      </p>
      <button
        onClick={() => {
          setError("");
          socket.connect();
        }}
      >
        Connect
      </button>
      <button onClick={() => socket.disconnect()}>Disconnect</button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          try {
            socket.sendJson({ type: "chat.send", text });
            setText("");
            setError("");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Send failed");
          }
        }}
      >
        <label>
          Message{" "}
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button disabled={state.status !== "open" || !text.trim()}>Send</button>
      </form>
      {(error || state.error) && (
        <p role="alert">{error || state.error?.message}</p>
      )}
      <ul>
        {messages.map((message, index) => (
          <li key={index}>{message}</li>
        ))}
      </ul>
    </section>
  );
}
