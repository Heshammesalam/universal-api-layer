import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSocketClient,
  type SocketClient,
  type SocketOptions,
} from "../src/websocket";
import { createApiClient } from "../src/core";
import { socketFactory } from "./socket-fixture";
afterEach(() => vi.useRealTimers());
const url = "wss://chat.test/socket";
function setup<T = unknown>(options: Partial<SocketOptions<T>> = {}) {
  const fixture = socketFactory();
  const client = createSocketClient<T>({
    url,
    webSocketFactory: fixture.factory,
    ...options,
  });
  return { ...fixture, client };
}
it("is lazy, has stable frozen snapshots and opens/sends explicitly", () => {
  const { client, factory, sockets } = setup({ protocols: ["chat.v1"] });
  expect(factory).not.toHaveBeenCalled();
  expect(client.getSnapshot()).toBe(client.getSnapshot());
  expect(Object.isFrozen(client.getSnapshot())).toBe(true);
  const listener = vi.fn();
  const off = client.subscribe(listener);
  client.connect();
  client.connect();
  expect(factory).toHaveBeenCalledExactlyOnceWith(url, ["chat.v1"]);
  expect(client.getSnapshot().status).toBe("connecting");
  sockets[0].open();
  expect(client.getSnapshot().status).toBe("open");
  client.sendJson({ message: "hello" });
  client.send("raw");
  expect(sockets[0].send.mock.calls).toEqual([
    ['{"message":"hello"}'],
    ["raw"],
  ]);
  off();
  listener.mockClear();
  client.disconnect();
  expect(listener).not.toHaveBeenCalled();
  expect(sockets[0].close).toHaveBeenCalledExactlyOnceWith(1000, "");
  client.dispose();
});
it("never queues or replays outgoing messages when disconnected or reconnecting", async () => {
  vi.useFakeTimers();
  const { client, sockets } = setup({
    reconnect: { jitter: false, baseDelayMs: 20 },
  });
  expect(() => client.sendJson({ id: 1 })).toThrow(/not open/);
  client.connect();
  expect(() => client.send("before open")).toThrow(/not open/);
  sockets[0].open();
  client.sendJson({ id: 2 });
  sockets[0].end();
  expect(() => client.send("offline")).toThrow(/not open/);
  await vi.advanceTimersByTimeAsync(20);
  sockets[1].open();
  expect(sockets[1].send).not.toHaveBeenCalled();
  client.dispose();
});
it("enforces outgoing buffer limits including UTF-8 byte length", () => {
  const { client, sockets } = setup({ maxBufferedAmount: 5 });
  client.connect();
  sockets[0].open();
  sockets[0].bufferedAmount = 2;
  expect(() => client.send("éé")).toThrow(/buffer limit/);
  client.send(new Uint8Array([1, 2, 3]));
  expect(sockets[0].send).toHaveBeenCalledTimes(1);
  client.dispose();
});
it("rejects unserializable JSON and invalid raw data without sending", () => {
  const { client, sockets } = setup();
  client.connect();
  sockets[0].open();
  expect(() => client.sendJson(undefined)).toThrow(/serializable/);
  expect(() => client.sendJson(1n)).toThrow(/serializable/);
  expect(() => client.send({} as never)).toThrow(/Unsupported/);
  expect(sockets[0].send).not.toHaveBeenCalled();
  client.dispose();
});
it("reports uncertain send failures without automatic replay", () => {
  const { client, sockets } = setup();
  client.connect();
  sockets[0].open();
  sockets[0].send.mockImplementation(() => {
    throw Error("lost connection");
  });
  expect(() => client.send("hello")).toThrow(/delivery is unknown/);
  expect(sockets[0].send).toHaveBeenCalledTimes(1);
  client.dispose();
});
it("parses and validates messages in order even with an asynchronous schema", async () => {
  let resolve!: (value: unknown) => void;
  const gate = new Promise<unknown>((r) => {
    resolve = r;
  });
  const { client, sockets } = setup({
    schema: async (value) => {
      if (value === 1) await gate;
      return { value };
    },
  });
  expectTypeOf(client).toEqualTypeOf<SocketClient<{ value: unknown }>>();
  const received: unknown[] = [];
  client.onMessage((value) => received.push(value));
  client.connect();
  sockets[0].open();
  sockets[0].message("1");
  sockets[0].message("2");
  await Promise.resolve();
  expect(received).toEqual([]);
  resolve(null);
  await vi.waitFor(() =>
    expect(received).toEqual([{ value: 1 }, { value: 2 }]),
  );
  client.dispose();
});
it("drops invalid JSON/schema payloads, reports errors and continues with the next message", async () => {
  const { client, sockets } = setup({
    schema: (value) => {
      if (typeof value !== "number") throw Error("number required");
      return value;
    },
  });
  const received = vi.fn(),
    errors = vi.fn();
  client.onMessage(received);
  client.onError(errors);
  client.connect();
  sockets[0].open();
  sockets[0].message("bad JSON");
  sockets[0].message('"bad schema"');
  sockets[0].message("5");
  await vi.waitFor(() => expect(received).toHaveBeenCalledExactlyOnceWith(5));
  expect(errors.mock.calls.map(([error]) => error.code)).toEqual([
    "parse",
    "validation",
  ]);
  client.dispose();
});
it("delivers raw strings and binary data when explicitly requested", async () => {
  const { client, sockets } = setup({ format: "raw" });
  const received = vi.fn();
  client.onMessage(received);
  client.connect();
  sockets[0].open();
  const binary = new ArrayBuffer(2);
  sockets[0].message("text");
  sockets[0].message(binary);
  await vi.waitFor(() =>
    expect(received.mock.calls).toEqual([["text"], [binary]]),
  );
  expect(sockets[0].binaryType).toBe("arraybuffer");
  client.dispose();
});
it.each(["size", "backlog"])(
  "closes without reconnecting when the incoming %s limit is exceeded",
  async (mode) => {
    vi.useFakeTimers();
    const { client, sockets, factory } = setup({
      maxMessageSize: 4,
      maxPendingMessages: 1,
      schema: () => new Promise(() => {}),
    });
    const errors = vi.fn();
    client.onError(errors);
    client.connect();
    sockets[0].open();
    if (mode === "size") sockets[0].message('"large"');
    else {
      sockets[0].message("1");
      sockets[0].message("2");
    }
    expect(client.getSnapshot().status).toBe("closed");
    expect(errors.mock.calls[0][0].code).toBe("backpressure");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  },
);
it("reconnects with capped exponential delay and a budget that does not reset on open", async () => {
  vi.useFakeTimers();
  const { client, sockets, factory } = setup({
    reconnect: {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 15,
      jitter: false,
    },
  });
  client.connect();
  sockets[0].open();
  sockets[0].end(1006);
  expect(client.getSnapshot()).toMatchObject({
    status: "reconnecting",
    reconnectAttempt: 1,
  });
  await vi.advanceTimersByTimeAsync(9);
  expect(factory).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  sockets[1].open();
  sockets[1].end(1013);
  await vi.advanceTimersByTimeAsync(14);
  expect(factory).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  sockets[2].open();
  sockets[2].end(1006);
  expect(client.getSnapshot()).toMatchObject({
    status: "closed",
    reconnectAttempt: 2,
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(factory).toHaveBeenCalledTimes(3);
  client.connect();
  expect(client.getSnapshot().reconnectAttempt).toBe(0);
  client.dispose();
});
it.each([1000, 1002, 1008, 1009, 4001, 4401, 4403])(
  "does not automatically reconnect on terminal close code %s",
  async (code) => {
    vi.useFakeTimers();
    const { client, sockets, factory } = setup();
    client.connect();
    sockets[0].open();
    sockets[0].end(code, "closed");
    expect(client.getSnapshot()).toMatchObject({
      status: "closed",
      close: { code, reason: "closed" },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory).toHaveBeenCalledTimes(1);
    client.dispose();
  },
);
it("times out a stalled handshake and releases it with bounded retries", async () => {
  vi.useFakeTimers();
  const { client, sockets, factory } = setup({
    connectTimeoutMs: 10,
    reconnect: { maxAttempts: 1, baseDelayMs: 5, jitter: false },
  });
  client.connect();
  await vi.advanceTimersByTimeAsync(10);
  expect(sockets[0].close).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15);
  expect(factory).toHaveBeenCalledTimes(2);
  expect(client.getSnapshot()).toMatchObject({
    status: "closed",
    error: { code: "timeout" },
  });
  expect(vi.getTimerCount()).toBe(0);
  client.dispose();
});
it("stops reconnect timers on disconnect and removes all native handlers", async () => {
  vi.useFakeTimers();
  const { client, sockets, factory } = setup();
  client.connect();
  sockets[0].open();
  sockets[0].end();
  client.disconnect();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(
    [...sockets[0].listeners.values()].every((set) => set.size === 0),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  client.dispose();
});
it.each(["logout", "switch"])(
  "closes on %s, drops pending validated messages and requires explicit reconnect",
  async (action) => {
    const session = createApiClient({
      session: { userId: "a", token: "secret" },
    });
    let resolve!: (value: string) => void;
    const { client, sockets } = setup({
      sessionClient: session,
      schema: () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    });
    const received = vi.fn();
    client.onMessage(received);
    client.connect();
    sockets[0].open();
    sockets[0].message("1");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    if (action === "logout") session.logout();
    else session.setSession({ userId: "b", token: "other" });
    resolve("old private data");
    await Promise.resolve();
    expect(client.getSnapshot().status).toBe("closed");
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(received).not.toHaveBeenCalled();
    expect(() => client.send("late")).toThrow(/not open/);
    if (action === "logout")
      expect(() => client.connect()).toThrow(/authenticated/);
    client.dispose();
  },
);
it("guards buffered same-turn messages when a message subscriber changes accounts", async () => {
  const session = createApiClient({ session: { userId: "a" } });
  const { client, sockets } = setup({ sessionClient: session });
  const received: unknown[] = [];
  client.onMessage((message) => {
    received.push(message);
    session.logout();
  });
  client.onMessage((message) => received.push(message));
  client.connect();
  sockets[0].open();
  sockets[0].message("1");
  sockets[0].message("2");
  await vi.waitFor(() => expect(client.getSnapshot().status).toBe("closed"));
  expect(received).toEqual([1]);
  client.dispose();
});
it("does not silently reconnect on same-user HTTP token rotation", () => {
  const session = createApiClient({ session: { userId: "a", token: "old" } });
  const { client, sockets } = setup({ sessionClient: session });
  client.connect();
  sockets[0].open();
  session.setSession({ userId: "a", token: "new" });
  expect(client.getSnapshot().status).toBe("open");
  expect(sockets[0].close).not.toHaveBeenCalled();
  client.dispose();
});
it.each(["open", "closed"])(
  "clears error diagnostics and close metadata on account changes while %s",
  async (status) => {
    const session = createApiClient({ session: { userId: "a" } });
    const { client, sockets } = setup({
      sessionClient: session,
      schema: () => {
        throw Error("synthetic private diagnostic");
      },
    });
    client.connect();
    sockets[0].open();
    sockets[0].message("1");
    await vi.waitFor(() =>
      expect(client.getSnapshot().error?.code).toBe("validation"),
    );
    if (status === "closed") sockets[0].end(1008, "synthetic private reason");
    session.logout();
    expect(client.getSnapshot()).toMatchObject({
      status: "closed",
      error: null,
      close: null,
    });
    client.dispose();
  },
);
it("gets fresh abortable connection tickets on reconnect while keeping URL details out of snapshots", async () => {
  vi.useFakeTimers();
  let ticket = 0;
  const { client, sockets, factory } = setup({
    url: async () => `wss://chat.test/socket?ticket=private-${++ticket}`,
    allowedOrigins: ["wss://chat.test"],
    reconnect: { baseDelayMs: 10, jitter: false },
  });
  client.connect();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].open();
  sockets[0].end();
  await vi.advanceTimersByTimeAsync(10);
  expect(factory.mock.calls.map(([target]) => target)).toEqual([
    "wss://chat.test/socket?ticket=private-1",
    "wss://chat.test/socket?ticket=private-2",
  ]);
  expect(JSON.stringify(client.getSnapshot())).not.toContain("private");
  client.dispose();
});
it("cancels ticket lookup on logout and rejects stale URL results", async () => {
  const session = createApiClient({ session: { userId: "a" } });
  let resolve!: (value: string) => void;
  let signal!: AbortSignal;
  const { client, factory } = setup({
    sessionClient: session,
    allowedOrigins: ["wss://chat.test"],
    url: (value) => {
      signal = value;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  client.connect();
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  session.logout();
  resolve(url);
  await Promise.resolve();
  expect(signal.aborted).toBe(true);
  expect(factory).not.toHaveBeenCalled();
  client.dispose();
});
it("blocks redirected ticket origins before any native connection", async () => {
  const { client, factory } = setup({
    url: async () => "wss://evil.test/?ticket=secret",
    allowedOrigins: ["wss://chat.test"],
  });
  client.connect();
  await vi.waitFor(() => expect(client.getSnapshot().status).toBe("closed"));
  expect(client.getSnapshot().error?.code).toBe("configuration");
  expect(factory).not.toHaveBeenCalled();
  client.dispose();
});
it("is safe against state-subscriber disconnect during connecting/open", () => {
  const { client, factory } = setup();
  client.subscribe(() => {
    if (client.getSnapshot().status === "connecting") client.disconnect();
  });
  client.connect();
  expect(factory).not.toHaveBeenCalled();
  expect(client.getSnapshot().status).toBe("closed");
  client.dispose();
});
it("isolates throwing subscribers and unsubscribe works", async () => {
  const { client, sockets } = setup();
  const errors = vi.fn(),
    received = vi.fn();
  client.onError(errors);
  client.onError(() => {
    throw Error("error listener");
  });
  client.onMessage(() => {
    throw Error("consumer");
  });
  const off = client.onMessage(received);
  client.connect();
  sockets[0].open();
  sockets[0].message("1");
  await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
  off();
  sockets[0].message("2");
  await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
  expect(received).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls[0][0].code).toBe("callback");
  client.dispose();
});
it("dispose is terminal and idempotent, while disconnect allows reconnect", () => {
  const { client, sockets, factory } = setup();
  client.connect();
  client.disconnect();
  client.connect();
  expect(factory).toHaveBeenCalledTimes(2);
  client.dispose();
  client.dispose();
  expect(client.getSnapshot().status).toBe("disposed");
  expect(sockets[1].close).toHaveBeenCalledTimes(1);
  expect(() => client.connect()).toThrow(/disposed/);
  expect(() => client.onMessage(() => {})).toThrow(/disposed/);
});
it.each([1001, 2999, 5000, NaN])(
  "validates close code %s before closing",
  (code) => {
    const { client } = setup();
    expect(() => client.disconnect(code)).toThrow(/Close code/);
    client.dispose();
  },
);
it("validates close reason in UTF-8 bytes", () => {
  const { client } = setup();
  expect(() => client.disconnect(1000, "é".repeat(62))).toThrow(/123/);
  client.dispose();
});
it.each([
  { url: "https://chat.test" },
  { url: "wss://user:pass@chat.test" },
  { url: "wss://chat.test/#fragment" },
  { url: () => url },
  { allowedOrigins: ["wss://chat.test/path"] },
  { connectTimeoutMs: 0 },
  { maxPendingMessages: -1 },
  { reconnect: { baseDelayMs: 100, maxDelayMs: 10 } },
  { protocols: ["duplicate", "duplicate"] },
  { protocols: ["bad space"] },
  { requiresAuth: true },
])("rejects invalid configuration %#", (config) => {
  expect(() => setup(config)).toThrow();
});
