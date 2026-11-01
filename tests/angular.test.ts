import "@angular/compiler";
import {
  createEnvironmentInjector,
  Injector,
  runInInjectionContext,
  type EnvironmentInjector,
  type Signal,
} from "@angular/core";
import { firstValueFrom, take, toArray, type Observable } from "rxjs";
import { expect, expectTypeOf, it, vi } from "vitest";
import {
  ApiService,
  injectApiClient,
  injectApiSession,
  provideApiClient,
} from "../src/angular";
import {
  createApiClient,
  type ApiResponse,
  type SessionSnapshot,
  type ServerSentEvent,
  type RequestOptions,
} from "../src/core";
import { createSocketClient } from "../src/websocket";
import {
  injectSocketMessage,
  injectSocketState,
} from "../src/websocket/angular";
import { socketFactory } from "./socket-fixture";
const environment = (factory: Parameters<typeof provideApiClient>[0]) =>
  createEnvironmentInjector(
    [provideApiClient(factory)],
    Injector.NULL as EnvironmentInjector,
  );
it("provides a client/service through DI and isolates factory-created SSR injectors", () => {
  const factory = vi.fn(() => createApiClient());
  const a = environment(factory),
    b = environment(factory);
  try {
    const first = runInInjectionContext(a, injectApiClient),
      second = runInInjectionContext(b, injectApiClient);
    expect(first).not.toBe(second);
    expect(a.get(ApiService).client).toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(a.get(ApiService)).toBe(a.get(ApiService));
    first.setSession({ userId: "a" });
    expect(second.getSessionSnapshot().userId).toBeNull();
  } finally {
    a.destroy();
    b.destroy();
  }
});
it("accepts an explicitly owned client instance and reports missing providers/context", () => {
  const client = createApiClient();
  const env = environment(client);
  try {
    expect(runInInjectionContext(env, injectApiClient)).toBe(client);
  } finally {
    env.destroy();
  }
  expect(() => injectApiClient()).toThrow();
  expect(() => injectApiSession(client)).toThrow();
});
it("creates cold independent HTTP observables with typed full responses and headers", async () => {
  const fetch = vi.fn(
    async () =>
      new Response('[{"id":1}]', {
        headers: { "content-type": "application/json", "x-total-count": "9" },
      }),
  );
  const api = new ApiService(createApiClient({ fetch }));
  const request = api.request$<{ id: number }[]>("/posts", {
    responseMode: "full",
  });
  expectTypeOf(request).toEqualTypeOf<
    Observable<ApiResponse<{ id: number }[]>>
  >();
  expect(fetch).not.toHaveBeenCalled();
  expect((await firstValueFrom(request)).headers.get("x-total-count")).toBe(
    "9",
  );
  await firstValueFrom(request);
  expect(fetch).toHaveBeenCalledTimes(2);
  api.dispose();
});
it("infers schema results, data-only and dynamic response mode types", async () => {
  const api = new ApiService(
    createApiClient({
      fetch: async () =>
        new Response("1", { headers: { "content-type": "application/json" } }),
    }),
  );
  const result = api.request$("/", {
    schema: (value: unknown) => ({ id: String(value) }),
  });
  expectTypeOf(result).toEqualTypeOf<Observable<{ id: string } | null>>();
  expect(await firstValueFrom(result)).toEqual({ id: "1" });
  const options: RequestOptions<number> = {};
  expectTypeOf(api.request$("/", options)).toEqualTypeOf<
    Observable<number | null | ApiResponse<number>>
  >();
  api.dispose();
});
it("forwards HTTP validation/auth errors without wrapping or retrying", async () => {
  const fetch = vi.fn(
    async () =>
      new Response('{"errors":{"text":["Required"]}}', {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
  );
  const api = new ApiService(createApiClient({ fetch }));
  await expect(firstValueFrom(api.request$("/"))).rejects.toMatchObject({
    code: "http",
    status: 422,
    fieldErrors: { text: ["Required"] },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  api.dispose();
});
it("does not start a request unsubscribed before its scheduled work", async () => {
  const fetch = vi.fn();
  const api = new ApiService(createApiClient({ fetch }));
  const subscription = api.request$("/").subscribe();
  subscription.unsubscribe();
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
  api.dispose();
});
it("unsubscribe aborts a pending HTTP request without emitting late data or errors", async () => {
  let signal!: AbortSignal;
  let resolve!: (value: Response) => void;
  const api = new ApiService(
    createApiClient({
      fetch: async (_, init) => {
        signal = init!.signal!;
        return new Promise((r) => {
          resolve = r;
        });
      },
    }),
  );
  const next = vi.fn(),
    error = vi.fn();
  const sub = api.request$("/").subscribe({ next, error });
  await vi.waitFor(() => expect(signal).toBeDefined());
  sub.unsubscribe();
  expect(signal.aborted).toBe(true);
  resolve(new Response("late"));
  await Promise.resolve();
  expect(next).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  api.dispose();
});
it("honors an external aborted signal before fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn();
  const api = new ApiService(createApiClient({ fetch }));
  await expect(
    firstValueFrom(api.request$("/", { signal: controller.signal })),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(fetch).not.toHaveBeenCalled();
  api.dispose();
});
it("cancels active provider-owned work on injector destruction and rejects future subscriptions", async () => {
  const client = createApiClient({ fetch: async () => new Promise(() => {}) });
  const env = environment(client);
  const api = env.get(ApiService);
  const result = firstValueFrom(api.request$("/"));
  const check = expect(result).rejects.toMatchObject({ code: "cancelled" });
  await Promise.resolve();
  env.destroy();
  await check;
  await expect(firstValueFrom(api.request$("/"))).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(client.getSessionSnapshot().userId).toBeNull();
});
it("does not log out a shared client or cancel another provider's request on destroy", async () => {
  const client = createApiClient({
    session: { userId: "a" },
    fetch: async () => new Response("ok"),
  });
  const a = environment(client),
    b = environment(client);
  a.get(ApiService);
  const other = b.get(ApiService);
  a.destroy();
  expect(await firstValueFrom(other.request$("/"))).toBe("ok");
  expect(client.getSessionSnapshot().userId).toBe("a");
  b.destroy();
});
it("cancels a subscription whose user changes before its first microtask", async () => {
  const fetch = vi.fn();
  const client = createApiClient({ session: { userId: "a" }, fetch });
  const api = new ApiService(client);
  const result = firstValueFrom(api.request$("/"));
  client.setSession({ userId: "b" });
  await expect(result).rejects.toMatchObject({ code: "cancelled" });
  expect(fetch).not.toHaveBeenCalled();
  api.dispose();
});
it("preserves managed refresh in observable requests", async () => {
  const refresh = vi.fn(async () => "fresh");
  let calls = 0;
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken: refresh,
    fetch: async () =>
      ++calls === 1 ? new Response(null, { status: 401 }) : new Response("ok"),
  });
  const api = new ApiService(client);
  expect(await firstValueFrom(api.request$("/"))).toBe("ok");
  expect(refresh).toHaveBeenCalledTimes(1);
  api.dispose();
});
it("publishes token-free readonly session signals and removes subscriptions on destroy", () => {
  const client = createApiClient({ session: { userId: "a", token: "secret" } });
  const env = environment(client);
  const session = runInInjectionContext(env, () => injectApiSession());
  expectTypeOf(session).toEqualTypeOf<Signal<SessionSnapshot>>();
  client.setSession({ userId: "b", token: "other" });
  expect(session().userId).toBe("b");
  expect(JSON.stringify(session())).not.toContain("secret");
  env.destroy();
  client.logout();
  expect(session().userId).toBe("b");
});
it("emits SSE incrementally and take(1) releases the underlying reader", async () => {
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(c) {
        sink = c;
      },
      cancel,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const api = new ApiService(createApiClient({ fetch: async () => response }));
  const stream = api.stream$("/", { format: "sse" });
  expectTypeOf(stream).toEqualTypeOf<Observable<ServerSentEvent>>();
  const first = firstValueFrom(stream.pipe(take(1)));
  sink.enqueue(new TextEncoder().encode("data: first\n\ndata: second\n\n"));
  expect((await first).data).toBe("first");
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  api.dispose();
});
it("emits text chunks and completes at EOF", async () => {
  const api = new ApiService(
    createApiClient({ fetch: async () => new Response("hello") }),
  );
  expectTypeOf(api.stream$("/")).toEqualTypeOf<Observable<string>>();
  expect(await firstValueFrom(api.stream$("/").pipe(toArray()))).toEqual([
    "hello",
  ]);
  api.dispose();
});
it("session changes abort streams before additional events reach Angular observers", async () => {
  const client = createApiClient({
    session: { userId: "a" },
    fetch: async () =>
      new Response("data: first\n\ndata: private\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const api = new ApiService(client);
  const values: string[] = [];
  await new Promise<void>((resolve, reject) =>
    api.stream$("/", { format: "sse" }).subscribe({
      next: (event) => {
        values.push(event.data);
        client.logout();
      },
      error: (error) => {
        try {
          expect(error.code).toBe("cancelled");
          resolve();
        } catch (e) {
          reject(e);
        }
      },
      complete: () => reject(Error("Expected session cancellation")),
    }),
  );
  expect(values).toEqual(["first"]);
  api.dispose();
});
it("Angular WebSocket signals/messages clean subscriptions while leaving shared connection ownership explicit", async () => {
  const { factory, sockets } = socketFactory();
  const socket = createSocketClient({
    url: "wss://chat.test",
    webSocketFactory: factory,
  });
  const env = environment(createApiClient());
  const listener = vi.fn();
  const state = runInInjectionContext(env, () => {
    injectSocketMessage(socket, listener);
    return injectSocketState(socket);
  });
  socket.connect();
  sockets[0].open();
  expect(state().status).toBe("open");
  sockets[0].message("1");
  await vi.waitFor(() => expect(listener).toHaveBeenCalledExactlyOnceWith(1));
  env.destroy();
  sockets[0].message("2");
  socket.disconnect();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(state().status).toBe("open");
  socket.dispose();
});
it("WebSocket inject helpers require an Angular injection context", () => {
  const socket = createSocketClient({ url: "wss://chat.test" });
  expect(() => injectSocketState(socket)).toThrow();
  expect(() => injectSocketMessage(socket, () => {})).toThrow();
  socket.dispose();
});
