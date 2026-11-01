import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import {
  createApiClient,
  type ServerSentEvent,
  type StreamOptions,
} from "../src/core";
const encoder = new TextEncoder();
function source(type = "text/plain") {
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        sink = controller;
      },
      cancel,
    }),
    { headers: { "content-type": type } },
  );
  return {
    response,
    cancel,
    push: (text: string) => sink.enqueue(encoder.encode(text)),
    bytes: (bytes: Uint8Array) => sink.enqueue(bytes),
    close: () => sink.close(),
    fail: (error: Error) => sink.error(error),
  };
}
async function collect<T>(values: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of values) result.push(item);
  return result;
}
afterEach(() => vi.useRealTimers());

it("delivers the first text chunk while the response is still open", async () => {
  const s = source();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => s.response);
  const client = createApiClient({ fetch });
  const stream = client.stream("/chat", {
    method: "POST",
    body: { message: "Hi" },
  });
  expect(fetch).not.toHaveBeenCalled();
  const first = stream.next();
  s.push("Hello");
  expect(await first).toEqual({ value: "Hello", done: false });
  const second = stream.next();
  s.push(" world");
  expect((await second).value).toBe(" world");
  s.close();
  expect((await stream.next()).done).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: "POST",
    body: '{"message":"Hi"}',
    cache: "no-store",
  });
});
it("decodes split UTF-8 characters and flushes the decoder at EOF", async () => {
  const s = source();
  const bytes = encoder.encode("مرحبا 🌍");
  for (const byte of bytes) s.bytes(new Uint8Array([byte]));
  s.bytes(new Uint8Array([0xe2]));
  s.close();
  const values = await collect(
    createApiClient({ fetch: async () => s.response }).stream("/"),
  );
  expect(values.join("")).toBe("مرحبا 🌍�");
});
it("parses SSE at every byte boundary with CRLF, multiline data, comments, IDs and retry hints", async () => {
  const input =
    "\uFEFF: heartbeat\r\nid: 7\r\nretry: 1200\r\nevent: delta\r\ndata: مرحبا 🌍\r\ndata: second\r\n\r\ndata: next\n\nid:\rid: bad\0id\rretry: -2\rdata:\r\rdata: incomplete";
  const s = source("Text/Event-Stream; charset=utf-8");
  for (const byte of encoder.encode(input)) s.bytes(new Uint8Array([byte]));
  s.close();
  const values = await collect(
    createApiClient({ fetch: async () => s.response }).stream("/", {
      format: "sse",
    }),
  );
  expect(values).toEqual([
    { event: "delta", data: "مرحبا 🌍\nsecond", id: "7", retry: 1200 },
    { event: "message", data: "next", id: "7", retry: 1200 },
    { event: "message", data: "", id: "", retry: 1200 },
  ]);
  expect(Object.isFrozen(values[0])).toBe(true);
});
it("yields complete SSE events before EOF and leaves application done sentinels untouched", async () => {
  const s = source("text/event-stream");
  const iterator = createApiClient({ fetch: async () => s.response }).stream(
    "/",
    { format: "sse" },
  );
  s.push('data: {"delta":"a"}\n\ndata: [DONE]\n\n');
  expect((await iterator.next()).value).toMatchObject({
    data: '{"delta":"a"}',
  });
  expect((await iterator.next()).value).toMatchObject({ data: "[DONE]" });
  await iterator.return();
  expect(s.cancel).toHaveBeenCalledTimes(1);
});
it("does not dispatch fields without data or an unterminated final event", async () => {
  const s = source("text/event-stream");
  s.push("event: discarded\n\nunknown: ignored\ndata\n\ndata: unfinished\n");
  s.close();
  expect(
    await collect(
      createApiClient({ fetch: async () => s.response }).stream("/", {
        format: "sse",
      }),
    ),
  ).toEqual([{ event: "message", data: "", id: "" }]);
});
it.each(["line", "event"])(
  "bounds SSE %s buffers and cancels the reader",
  async (kind) => {
    const s = source("text/event-stream");
    s.push(
      kind === "line"
        ? "data: 123456789012345"
        : "data: 12345\ndata: 67890\ndata: abcde\n",
    );
    await expect(
      collect(
        createApiClient({ fetch: async () => s.response }).stream("/", {
          format: "sse",
          maxEventSize: 16,
        }),
      ),
    ).rejects.toMatchObject({ code: "parse" });
    expect(s.cancel).toHaveBeenCalledTimes(1);
  },
);
it("rejects wrong SSE content type before delivering data", async () => {
  const s = source("application/json");
  s.push('{"message":"not SSE"}');
  await expect(
    collect(
      createApiClient({ fetch: async () => s.response }).stream("/", {
        format: "sse",
      }),
    ),
  ).rejects.toMatchObject({ code: "parse", status: 200 });
  expect(s.cancel).toHaveBeenCalledTimes(1);
});
it.each([0, -1, Infinity, 1.5])(
  "rejects invalid event limit %s before transport",
  async (maxEventSize) => {
    const fetch = vi.fn();
    await expect(
      collect(createApiClient({ fetch }).stream("/", { maxEventSize })),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("rejects an invalid JavaScript format before transport", async () => {
  const fetch = vi.fn();
  await expect(
    collect(
      createApiClient({ fetch }).stream("/", {
        format: "bad",
      } as unknown as StreamOptions),
    ),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(fetch).not.toHaveBeenCalled();
});
it("cancels the underlying reader and transport when the consumer breaks", async () => {
  const s = source();
  let signal!: AbortSignal;
  const client = createApiClient({
    fetch: async (_, init) => {
      signal = init!.signal!;
      return s.response;
    },
  });
  s.push("first");
  for await (const item of client.stream("/")) {
    expect(item).toBe("first");
    break;
  }
  expect(s.cancel).toHaveBeenCalledTimes(1);
  expect(signal.aborted).toBe(true);
  expect(s.response.body!.locked).toBe(false);
});
it("external abort interrupts a pending read even when a custom fetch ignores the signal", async () => {
  const s = source();
  const controller = new AbortController();
  const iterator = createApiClient({ fetch: async () => s.response }).stream(
    "/",
    { signal: controller.signal },
  );
  s.push("first");
  await iterator.next();
  const next = iterator.next();
  const check = expect(next).rejects.toMatchObject({ code: "cancelled" });
  controller.abort();
  await check;
  expect(s.cancel).toHaveBeenCalledTimes(1);
  expect(s.response.body!.locked).toBe(false);
});
it("keeps the total request deadline active after the first chunk", async () => {
  vi.useFakeTimers();
  const s = source();
  const iterator = createApiClient({ fetch: async () => s.response }).stream(
    "/",
    { timeoutMs: 50 },
  );
  s.push("first");
  await iterator.next();
  const check = expect(iterator.next()).rejects.toMatchObject({
    code: "timeout",
  });
  await vi.advanceTimersByTimeAsync(51);
  await check;
  expect(s.cancel).toHaveBeenCalledTimes(1);
});
it("clears deadlines promptly when aborting a consumer paused at a yield", async () => {
  vi.useFakeTimers();
  const s = source();
  const controller = new AbortController();
  const iterator = createApiClient({ fetch: async () => s.response }).stream(
    "/",
    { signal: controller.signal },
  );
  s.push("first");
  await iterator.next();
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  expect(s.cancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  await iterator.return();
});
it("supports disabling the total deadline for a long-lived stream", async () => {
  vi.useFakeTimers();
  const s = source();
  const iterator = createApiClient({ fetch: async () => s.response }).stream(
    "/",
    { timeoutMs: 0 },
  );
  s.push("first");
  await iterator.next();
  await vi.advanceTimersByTimeAsync(60_000);
  s.push("late");
  expect((await iterator.next()).value).toBe("late");
  await iterator.return();
});
it.each(["logout", "switch"])(
  "blocks already buffered SSE events on %s",
  async (action) => {
    const s = source("text/event-stream");
    const client = createApiClient({
      session: { userId: "a", token: "private" },
      fetch: async () => s.response,
    });
    const iterator = client.stream("/", { format: "sse" });
    s.push("data: first\n\ndata: secret\n\n");
    expect((await iterator.next()).value).toMatchObject({ data: "first" });
    if (action === "logout") client.logout();
    else client.setSession({ userId: "b", token: "other" });
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
    expect(s.cancel).toHaveBeenCalledTimes(1);
  },
);
it("refreshes once on HTTP 401 before streaming and forwards auth, params and no-store", async () => {
  const refreshToken = vi.fn(async () => "fresh");
  const inits: RequestInit[] = [];
  const client = createApiClient({
    baseUrl: "https://api.test",
    session: { userId: "a", token: "old" },
    refreshToken,
    fetch: async (url, init) => {
      expect(url).toBe("https://api.test/chat?q=hi");
      inits.push(init!);
      return inits.length === 1
        ? new Response(null, { status: 401 })
        : new Response("data: hello\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
    },
  });
  expect(
    await collect(
      client.stream("/chat", {
        format: "sse",
        params: { q: "hi" },
        method: "POST",
        body: { prompt: "hello" },
        requiresAuth: true,
      }),
    ),
  ).toEqual([{ event: "message", data: "hello", id: "" }]);
  expect(refreshToken).toHaveBeenCalledTimes(1);
  expect(inits).toHaveLength(2);
  expect(new Headers(inits[1].headers).get("authorization")).toBe(
    "Bearer fresh",
  );
  expect(new Headers(inits[1].headers).get("accept")).toBe("text/event-stream");
  expect(inits[1]).toMatchObject({ cache: "no-store", redirect: "error" });
});
it("never replays a request after a partial response fails", async () => {
  const s = source();
  const refreshToken = vi.fn();
  const fetch = vi.fn(async () => s.response);
  const iterator = createApiClient({
    session: { userId: "a", token: "t" },
    refreshToken,
    fetch,
  }).stream("/", { method: "POST" });
  s.push("partial");
  await iterator.next();
  s.fail(new Error("connection lost"));
  await expect(iterator.next()).rejects.toMatchObject({ code: "network" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(refreshToken).not.toHaveBeenCalled();
});
it("preserves structured HTTP errors instead of treating them as stream messages", async () => {
  await expect(
    collect(
      createApiClient({
        fetch: async () =>
          new Response('{"message":"Denied","errors":{"prompt":["Invalid"]}}', {
            status: 422,
            headers: { "content-type": "application/json" },
          }),
      }).stream("/"),
    ),
  ).rejects.toMatchObject({
    status: 422,
    code: "http",
    message: "Denied",
    fieldErrors: { prompt: ["Invalid"] },
  });
});
it("enforces auth and allowed origins before sending a stream", async () => {
  const fetch = vi.fn();
  const client = createApiClient({ baseUrl: "https://api.test", fetch });
  await expect(
    collect(client.stream("/", { requiresAuth: true })),
  ).rejects.toMatchObject({ code: "auth" });
  await expect(
    collect(client.stream("https://evil.test/")),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps whole-response schemas separate from stream payloads and has typed output", async () => {
  const schema = vi.fn(() => {
    throw Error("whole body schema");
  });
  const client = createApiClient({
    schema,
    fetch: async () => new Response("ok"),
  });
  expectTypeOf(client.stream("/")).toEqualTypeOf<
    AsyncGenerator<string, void, unknown>
  >();
  expectTypeOf(client.stream("/", { format: "sse" })).toEqualTypeOf<
    AsyncGenerator<ServerSentEvent, void, unknown>
  >();
  expect(await collect(client.stream("/"))).toEqual(["ok"]);
  expect(schema).not.toHaveBeenCalled();
});
it("returns no messages for 204 and does not leave a deadline behind", async () => {
  vi.useFakeTimers();
  expect(
    await collect(
      createApiClient({
        fetch: async () => new Response(null, { status: 204 }),
      }).stream("/", { format: "sse" }),
    ),
  ).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
