// @vitest-environment node
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { createSocketClient } from "../src/websocket";

it("exchanges JSON over a real WebSocket using the runtime's native client", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (socket) =>
    socket.on("message", (data) =>
      socket.send(JSON.stringify({ echo: JSON.parse(data.toString()) })),
    ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing socket port");
  const client = createSocketClient<{ echo: { message: string } }>({
    url: `ws://127.0.0.1:${address.port}`,
    reconnect: false,
  });
  const received = new Promise<unknown>((resolve, reject) => {
    client.onMessage(resolve);
    client.onError(reject);
  });
  client.subscribe(() => {
    if (client.getSnapshot().status === "open")
      client.sendJson({ message: "hello" });
  });
  try {
    client.connect();
    expect(await received).toEqual({ echo: { message: "hello" } });
    expect(client.getSnapshot().status).toBe("open");
  } finally {
    client.dispose();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
