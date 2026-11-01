import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  invokeCallback,
  invokeAsyncCallback,
  runMutation,
} from "../src/core";
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
afterEach(() => vi.useRealTimers());
describe("authentication, cancellation and timeout", () => {
  it("settles timeout during token lookup, signals the provider and never starts fetch after late resolution", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    let signal!: AbortSignal;
    const fetch = vi.fn(async () => json({}));
    const client = createApiClient({
      timeoutMs: 10,
      getToken: (received) => {
        signal = received;
        return new Promise<string>((r) => {
          resolve = r;
        });
      },
      fetch,
    });
    const result = expect(client.request("/users")).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(signal.aborted).toBe(true);
    resolve("late-token");
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels a never-settling token provider", async () => {
    const controller = new AbortController();
    const fetch = vi.fn();
    const client = createApiClient({
      getToken: () => new Promise<string>(() => {}),
      fetch,
    });
    const result = expect(
      client.request("/", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    controller.abort();
    await result;
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not run auth or fetch for an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const getToken = vi.fn();
    const fetch = vi.fn();
    await expect(
      createApiClient({ getToken, fetch }).request("/", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves an auth failure as its cause", async () => {
    const cause = new Error("token provider failed");
    await expect(
      createApiClient({ getToken: () => Promise.reject(cause) }).request("/"),
    ).rejects.toMatchObject({ code: "auth", cause });
  });
  it("times out a custom fetch even when it ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const client = createApiClient({
      timeoutMs: 10,
      fetch: () => new Promise<Response>(() => {}),
    });
    const result = expect(client.request("/")).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });
  it("times out while reading a body", async () => {
    vi.useFakeTimers();
    const response = json({});
    vi.spyOn(response, "text").mockImplementation(
      () => new Promise<string>(() => {}),
    );
    const client = createApiClient({
      timeoutMs: 10,
      fetch: async () => response,
    });
    const result = expect(client.request("/")).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });
  it.each([-1, NaN, Infinity])(
    "rejects invalid timeout %s",
    async (timeoutMs) => {
      await expect(
        createApiClient().request("/", { timeoutMs }),
      ).rejects.toMatchObject({ code: "configuration" });
    },
  );
  it("cleans up timeout and external abort listener on success", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await createApiClient({
      timeoutMs: 100,
      fetch: async () => json({}),
    }).request("/", { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("origin boundaries", () => {
  it("blocks a different origin before reading credentials", async () => {
    const getToken = vi.fn(() => "secret");
    const fetch = vi.fn();
    const client = createApiClient({
      baseUrl: "https://trusted.example/api",
      getToken,
      headers: { "x-api-key": "secret" },
      credentials: "include",
      fetch,
    });
    await expect(
      client.request("https://other.example/collect"),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows configured origins with explicit credential forwarding", async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    const client = createApiClient({
      baseUrl: "https://trusted.example/api",
      allowedOrigins: ["https://other.example"],
      getToken: () => "token",
      credentials: "include",
      fetch,
    });
    await client.request("https://other.example/collect");
    expect(fetch).toHaveBeenCalledWith(
      "https://other.example/collect",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(
      (fetch.mock.calls as unknown as [string, RequestInit][])[0][1].headers,
    ).toBeInstanceOf(Headers);
    expect(
      new Headers(
        (fetch.mock.calls as unknown as [string, RequestInit][])[0][1].headers,
      ).get("authorization"),
    ).toBe("Bearer token");
  });
  it.each([
    "//evil.example/a",
    "/\\evil.example/a",
    "https://user:pass@trusted.example/a",
    "javascript:alert(1)",
    "https://evil.example:bad/a",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(
      createApiClient({ baseUrl: "https://trusted.example/api" }).request(url),
    ).rejects.toMatchObject({ code: "configuration" });
  });
  it("retains same-origin absolute and relative URL support", async () => {
    const fetch = vi.fn(async () => json({}));
    const client = createApiClient({
      baseUrl: "https://trusted.example/api/",
      fetch,
    });
    await client.request("/users", { params: { page: 1 } });
    await client.request("https://trusted.example/users");
    expect(
      fetch.mock.calls.map((call) => (call as unknown as [string])[0]),
    ).toEqual([
      "https://trusted.example/api/users?page=1",
      "https://trusted.example/users",
    ]);
  });
});
describe("response and error contract", () => {
  it.each([200, 204, 205])(
    "returns null for an empty successful %s",
    async (status) => {
      expect(
        await createApiClient({
          fetch: async () => new Response(null, { status }),
        }).request("/"),
      ).toBeNull();
    },
  );
  it("rejects malformed success JSON with a parse error", async () => {
    await expect(
      createApiClient({
        fetch: async () =>
          new Response("{broken", {
            headers: { "content-type": "application/json" },
          }),
      }).request("/"),
    ).rejects.toMatchObject({
      code: "parse",
      status: 200,
      cause: expect.any(SyntaxError),
    });
  });
  it("preserves HTTP status and raw diagnostics for malformed error JSON", async () => {
    await expect(
      createApiClient({
        fetch: async () =>
          new Response("{broken", {
            status: 502,
            headers: { "content-type": "application/json" },
          }),
      }).request("/"),
    ).rejects.toMatchObject({ code: "http", status: 502, data: "{broken" });
  });
  it("keeps network cause without treating it as server payload", async () => {
    const cause = new TypeError("connection failed");
    const client = createApiClient({
      fetch: async () => {
        throw cause;
      },
    });
    await expect(client.request("/")).rejects.toMatchObject({
      code: "network",
      cause,
      data: undefined,
    });
  });
  it("passes FormData through without a JSON content type", async () => {
    const fetch = vi.fn(async () => json({}));
    const body = new FormData();
    body.append("name", "Bahaa");
    await createApiClient({ fetch }).request("/", { method: "POST", body });
    const init = (fetch.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(init.body).toBe(body);
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });
  it("normalizes sync and async callback failures", async () => {
    const cause = new Error("application failure");
    expect(() =>
      invokeCallback(() => {
        throw cause;
      }),
    ).toThrow(ApiError);
    await expect(
      invokeAsyncCallback(async () => {
        throw cause;
      }),
    ).rejects.toMatchObject({ code: "callback", cause });
    await expect(
      runMutation(
        createApiClient({ fetch: async () => json({}) }),
        {
          url: "/",
          mapPayload: () => {
            throw cause;
          },
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "callback", cause });
  });
});
describe("private cache identity", () => {
  it("never serializes credential headers, while retaining representation headers", () => {
    const client = createApiClient({
      headers: {
        Authorization: "default-secret",
        "X-Custom-Secret": "default-api-key",
        Accept: "application/json",
      },
    });
    const key = client.queryKey(["users"], "/users", undefined, {
      Authorization: "query-secret",
      Cookie: "session-secret",
      "X-Api-Key": "query-api-key",
      "X-Other-Secret": "custom-secret",
      "Accept-Language": "ar",
    });
    const serialized = JSON.stringify(key);
    for (const secret of [
      "default-secret",
      "default-api-key",
      "query-secret",
      "session-secret",
      "query-api-key",
      "custom-secret",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("application/json");
    expect(serialized).toContain("ar");
  });
  it("gives clients independent default scopes and supports intentional SSR sharing", () => {
    const a = createApiClient();
    const b = createApiClient();
    expect(a.queryKey(["users"], "/users")).not.toEqual(
      b.queryKey(["users"], "/users"),
    );
    expect(
      createApiClient({ cacheScope: "app-v1" }).queryKey(["users"], "/users"),
    ).toEqual(
      createApiClient({ cacheScope: "app-v1" }).queryKey(["users"], "/users"),
    );
    expect(
      a.queryKey(["users"], "/users", undefined, undefined, "account-a"),
    ).not.toEqual(
      a.queryKey(["users"], "/users", undefined, undefined, "account-b"),
    );
  });
  it("snapshots default headers and does not mutate caller headers", async () => {
    const headers = new Headers({ Accept: "application/json" });
    const client = createApiClient({ headers, fetch: async () => json({}) });
    const before = client.queryKey(["users"], "/users");
    headers.set("Accept", "text/plain");
    expect(client.queryKey(["users"], "/users")).toEqual(before);
    await client.request("/");
    expect(headers.get("authorization")).toBeNull();
  });
});

it("does not follow redirects implicitly with client credentials", async () => {
  const fetch = vi.fn(async () => json({}));
  await createApiClient({ fetch }).request("/");
  expect(fetch).toHaveBeenCalledWith(
    "/",
    expect.objectContaining({ redirect: "error" }),
  );
});
