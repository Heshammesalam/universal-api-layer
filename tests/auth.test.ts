import { z } from "zod";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  DEFAULT_TIMEOUT_MS,
  type StandardSchema,
} from "../src/core";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());
it("uses a 15-second default deadline", async () => {
  vi.useFakeTimers();
  const client = createApiClient({
    fetch: () => new Promise<Response>(() => {}),
  });
  let settled = false;
  const result = expect(
    client.request("/").finally(() => {
      settled = true;
    }),
  ).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await result;
});
it("allows timeout 0 and per-request deadline overrides", async () => {
  vi.useFakeTimers();
  const signal = new AbortController();
  const client = createApiClient({
    timeoutMs: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  const pending = expect(
    client.request("/", { signal: signal.signal }),
  ).rejects.toMatchObject({ code: "cancelled" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(vi.getTimerCount()).toBe(0);
  signal.abort();
  await pending;
  const short = expect(
    client.request("/", { timeoutMs: 5 }),
  ).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(5);
  await short;
});
it("separates users and tenants without putting tokens in keys or snapshots", () => {
  const client = createApiClient();
  const listener = vi.fn();
  const unsubscribe = client.subscribeSession(listener);
  client.setSession({ userId: "a", token: "SECRET_A", tenantId: "one" });
  const snapshot = client.getSessionSnapshot();
  const key = client.queryKey(["me"], "/me");
  client.setSession({ userId: "a", token: "SECRET_B", tenantId: "one" });
  expect(client.getSessionSnapshot()).toBe(snapshot);
  expect(client.queryKey(["me"], "/me")).toEqual(key);
  expect(listener).toHaveBeenCalledTimes(1);
  client.setSession({ userId: "a", token: "SECRET_C", tenantId: "two" });
  expect(client.queryKey(["me"], "/me")).not.toEqual(key);
  client.logout();
  expect(client.getSessionSnapshot().userId).toBeNull();
  expect(
    JSON.stringify([
      client,
      client.getSessionSnapshot(),
      client.queryKey([], "/"),
    ]),
  ).not.toContain("SECRET");
  unsubscribe();
});
it("aborts old requests when switching accounts even if fetch ignores signals", async () => {
  const gate = deferred<Response>();
  const client = createApiClient({
    session: { userId: "a", token: "a" },
    fetch: () => gate.promise,
  });
  const old = expect(client.request("/")).rejects.toMatchObject({
    code: "cancelled",
  });
  await Promise.resolve();
  client.setSession({ userId: "b", token: "b" });
  await old;
  gate.resolve(json("private-a"));
  expect(client.getSessionSnapshot().userId).toBe("b");
});
it("requires an identified session when requiresAuth is set", async () => {
  const fetch = vi.fn();
  await expect(
    createApiClient({ fetch }).request("/", { requiresAuth: true }),
  ).rejects.toMatchObject({ code: "auth", status: 401 });
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects ambiguous managed/legacy authentication configuration", () => {
  expect(() =>
    createApiClient({ getToken: () => "old", refreshToken: async () => "new" }),
  ).toThrow(ApiError);
  expect(() => createApiClient({ session: { userId: "" } })).toThrow(ApiError);
});
it("runs one refresh for concurrent 401s and replays each request with the new token", async () => {
  const gate = deferred<string>();
  const refreshToken = vi.fn(() => gate.promise);
  const bodies: unknown[] = [];
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken,
    fetch: async (_url, init) => {
      bodies.push(init?.body);
      return new Headers(init?.headers).get("authorization") === "Bearer fresh"
        ? json("ok")
        : json({}, 401);
    },
  });
  const key = client.queryKey([], "/");
  const requests = [1, 2, 3].map((id) =>
    client.request("/", { method: "POST", body: { id } }),
  );
  await vi.waitFor(() => expect(refreshToken).toHaveBeenCalledTimes(1));
  gate.resolve("fresh");
  expect(await Promise.all(requests)).toEqual(["ok", "ok", "ok"]);
  expect(client.queryKey([], "/")).toEqual(key);
  expect(bodies).toHaveLength(6);
  expect(
    bodies.filter((value) => value === JSON.stringify({ id: 1 })),
  ).toHaveLength(2);
  expect(await client.request("/")).toBe("ok");
  expect(refreshToken).toHaveBeenCalledTimes(1);
});
it("does not start a second refresh for a late old-token 401", async () => {
  const late = deferred<Response>();
  let oldCalls = 0;
  const refreshToken = vi.fn(async () => "fresh");
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken,
    fetch: async (_url, init) => {
      if (new Headers(init?.headers).get("authorization") === "Bearer fresh")
        return json("ok");
      return ++oldCalls === 2 ? late.promise : json({}, 401);
    },
  });
  const first = client.request("/");
  const second = client.request("/");
  expect(await first).toBe("ok");
  late.resolve(json({}, 401));
  expect(await second).toBe("ok");
  expect(refreshToken).toHaveBeenCalledTimes(1);
});
it("does not cancel a shared refresh when one caller times out", async () => {
  vi.useFakeTimers();
  const gate = deferred<string>();
  let refreshSignal!: AbortSignal;
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken: (signal) => {
      refreshSignal = signal;
      return gate.promise;
    },
    fetch: async (_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer fresh"
        ? json("ok")
        : json({}, 401),
  });
  const short = expect(
    client.request("/", { timeoutMs: 10 }),
  ).rejects.toMatchObject({ code: "timeout" });
  const long = client.request("/", { timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(10);
  await short;
  expect(refreshSignal.aborted).toBe(false);
  gate.resolve("fresh");
  expect(await long).toBe("ok");
});
it("refresh failure logs out and preserves its cause", async () => {
  const cause = new Error("refresh unavailable");
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken: async () => {
      throw cause;
    },
    fetch: async () => json({}, 401),
  });
  await expect(client.request("/")).rejects.toMatchObject({
    code: "auth",
    cause,
  });
  expect(client.getSessionSnapshot().userId).toBeNull();
});
it("bounds the shared refresh deadline", async () => {
  vi.useFakeTimers();
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshTimeoutMs: 10,
    refreshToken: () => new Promise<string>(() => {}),
    fetch: async () => json({}, 401),
  });
  const result = expect(
    client.request("/", { timeoutMs: 100 }),
  ).rejects.toMatchObject({ code: "auth" });
  await vi.advanceTimersByTimeAsync(10);
  await result;
  expect(client.getSessionSnapshot().userId).toBeNull();
});
it("does not restore an old identity after logout and late refresh completion", async () => {
  const gate = deferred<string>();
  const refreshToken = vi.fn(() => gate.promise);
  const auth: string[] = [];
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken,
    fetch: async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization")!;
      auth.push(token);
      return token === "Bearer b" ? json("b") : json({}, 401);
    },
  });
  const old = expect(client.request("/")).rejects.toMatchObject({
    code: "cancelled",
  });
  await vi.waitFor(() => expect(refreshToken).toHaveBeenCalledOnce());
  client.logout();
  client.setSession({ userId: "b", token: "b" });
  await old;
  gate.resolve("LATE_A");
  expect(await client.request("/")).toBe("b");
  expect(auth).not.toContain("Bearer LATE_A");
});
it("uses a manually rotated token instead of a stale refresh result", async () => {
  const gate = deferred<string>();
  const refreshToken = vi.fn(() => gate.promise);
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken,
    fetch: async (_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer manual"
        ? json("ok")
        : json({}, 401),
  });
  const request = client.request("/");
  await vi.waitFor(() => expect(refreshToken).toHaveBeenCalledOnce());
  client.setSession({ userId: "a", token: "manual" });
  expect(await request).toBe("ok");
  gate.resolve("stale");
  expect(await client.request("/")).toBe("ok");
});
it("retries a rejected refresh only once, then clears authentication", async () => {
  const fetch = vi.fn(async () => json({}, 401));
  const refreshToken = vi.fn(async () => "bad");
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken,
    fetch,
  });
  await expect(client.request("/")).rejects.toMatchObject({
    code: "auth",
    status: 401,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(refreshToken).toHaveBeenCalledOnce();
  expect(client.getSessionSnapshot().userId).toBeNull();
});
it("can disable refresh on a request without logging out", async () => {
  const refreshToken = vi.fn(async () => "new");
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken,
    fetch: async () => json({}, 401),
  });
  await expect(client.request("/", { authRetry: false })).rejects.toMatchObject(
    { code: "http", status: 401 },
  );
  expect(refreshToken).not.toHaveBeenCalled();
  expect(client.getSessionSnapshot().userId).toBe("a");
});
it("supports a refresh endpoint on the same client when authRetry is false", async () => {
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken: async (signal) => {
      const data = await client.request<{ token: string }>("/refresh", {
        authRetry: false,
        signal,
      });
      return data!.token;
    },
    fetch: async (url, init) =>
      url === "/refresh"
        ? json({ token: "fresh" })
        : new Headers(init?.headers).get("authorization") === "Bearer fresh"
          ? json("ok")
          : json({}, 401),
  });
  expect(await client.request("/resource")).toBe("ok");
});
it("validates and infers a transformed response", async () => {
  const client = createApiClient({ fetch: async () => json({ id: 1 }) });
  const result = client.request("/", {
    schema: (data: unknown) => {
      if (
        !data ||
        typeof data !== "object" ||
        !("id" in data) ||
        typeof data.id !== "number"
      )
        throw Error("bad response");
      return { id: String(data.id) };
    },
  });
  expectTypeOf(result).toEqualTypeOf<Promise<{ id: string } | null>>();
  expect(await result).toEqual({ id: "1" });
});
it("turns schema failures into validation ApiErrors", async () => {
  const cause = new Error("expected an id");
  await expect(
    createApiClient({ fetch: async () => json({}) }).request("/", {
      schema: () => {
        throw cause;
      },
    }),
  ).rejects.toMatchObject({ code: "validation", status: 200, cause });
});
it("supports Standard Schema async validation and issues", async () => {
  const schema: StandardSchema<{ id: number }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: async (value) =>
        value &&
        typeof value === "object" &&
        "id" in value &&
        typeof value.id === "number"
          ? { value: { id: value.id } }
          : { issues: [{ message: "id must be a number" }] },
    },
  };
  expect(
    await createApiClient({ fetch: async () => json({ id: 1 }) }).request("/", {
      schema,
    }),
  ).toEqual({ id: 1 });
  await expect(
    createApiClient({ fetch: async () => json({}) }).request("/", { schema }),
  ).rejects.toMatchObject({
    code: "validation",
    cause: { issues: [{ message: "id must be a number" }] },
  });
});
it("supports parser objects, global schemas and per-request opt out", async () => {
  const schema = {
    parse: (data: unknown) => {
      if (typeof data !== "number") throw Error("number required");
      return data + 1;
    },
  };
  const client = createApiClient({ fetch: async () => json(1), schema });
  expect(await client.request("/")).toBe(2);
  expect(await client.request("/", { schema: false })).toBe(1);
  expect(
    await client.request("/", {
      schema: { parse: () => 0, parseAsync: async () => 5 },
    }),
  ).toBe(5);
});
it("validates empty responses, not error bodies, and deadlines cover async validation", async () => {
  const schema = vi.fn(() => {
    throw Error("no empty body");
  });
  await expect(
    createApiClient({
      fetch: async () => new Response(null, { status: 204 }),
    }).request("/", { schema }),
  ).rejects.toMatchObject({ code: "validation" });
  schema.mockClear();
  await expect(
    createApiClient({ fetch: async () => json({}, 422) }).request("/", {
      schema,
    }),
  ).rejects.toMatchObject({ code: "http", status: 422 });
  expect(schema).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const result = expect(
    createApiClient({ fetch: async () => json({}), timeoutMs: 10 }).request(
      "/",
      { schema: () => new Promise(() => {}) },
    ),
  ).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(10);
  await result;
});

it("supports real Zod schemas with inferred output and async refinements", async () => {
  const client = createApiClient({ fetch: async () => json({ id: 1 }) });
  const schema = z
    .object({ id: z.number() })
    .transform((value) => ({ id: String(value.id) }));
  const parsed = client.request("/", { schema });
  expectTypeOf(parsed).toEqualTypeOf<Promise<{ id: string } | null>>();
  expect(await parsed).toEqual({ id: "1" });
  await expect(
    client.request("/", {
      schema: z.object({ id: z.number().refine(async (value) => value > 5) }),
    }),
  ).rejects.toMatchObject({ code: "validation" });
});
it("rejects validators which accidentally return undefined", async () => {
  await expect(
    createApiClient({ fetch: async () => json({}) }).request("/", {
      schema: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "validation" });
});

it("bypasses HTTP cache across managed login, account switching and logout", async () => {
  const cached = new Map<string, string>();
  const modes: unknown[] = [];
  const client = createApiClient({
    session: { userId: "a", token: "a" },
    fetch: async (url, init) => {
      modes.push(init?.cache);
      const key = String(url);
      const networkValue =
        new Headers(init?.headers).get("authorization") ?? "guest";
      if (init?.cache !== "no-store" && cached.has(key))
        return json(cached.get(key));
      if (init?.cache !== "no-store") cached.set(key, networkValue);
      return json(networkValue);
    },
  });
  cached.set("/me", "OLD_PRIVATE_HTTP_CACHE");
  expect(await client.request("/me")).toBe("Bearer a");
  client.setSession({ userId: "b", token: "b" });
  expect(await client.request("/me")).toBe("Bearer b");
  client.logout();
  expect(await client.request("/me")).toBe("guest");
  expect(modes).toEqual(["no-store", "no-store", "no-store"]);
});
it("keeps public HTTP cache behavior but bypasses it for legacy or explicit Bearer auth", async () => {
  const modes: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    modes.push(init?.cache);
    return json({});
  };
  await createApiClient({ fetch }).request("/");
  await createApiClient({ fetch, getToken: () => "legacy" }).request("/");
  await createApiClient({ fetch }).request("/", {
    headers: { Authorization: "Bearer manual" },
  });
  expect(modes).toEqual(["default", "no-store", "no-store"]);
});
