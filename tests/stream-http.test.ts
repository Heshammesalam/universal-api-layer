// @vitest-environment node
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createApiClient } from "../src/core";

it("receives SSE incrementally over a real HTTP connection before the server ends the response", async () => {
  let finish!: () => void;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    finish = () => response.end("data: second\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing server port");
  const stream = createApiClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  }).stream("/chat", {
    format: "sse",
    method: "POST",
    body: { prompt: "hello" },
    timeoutMs: 2000,
  });
  try {
    expect((await stream.next()).value).toMatchObject({ data: "first" });
    finish();
    expect((await stream.next()).value).toMatchObject({ data: "second" });
    expect((await stream.next()).done).toBe(true);
  } finally {
    await stream.return();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
