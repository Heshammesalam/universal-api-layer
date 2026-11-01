import { expect, expectTypeOf, it, vi, afterEach } from "vitest";
import {
  createApiClient,
  ApiError,
  type ApiResponse,
  type RequestOptions,
} from "../src/core";
const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
afterEach(() => vi.useRealTimers());
it("keeps data-only requests compatible and exposes metadata only when requested", async () => {
  const client = createApiClient({
    fetch: async () =>
      json([{ id: 1 }], {
        status: 201,
        statusText: "Created",
        headers: { "X-Total-Count": "42" },
      }),
  });
  expect(await client.request("/posts")).toEqual([{ id: 1 }]);
  const full = await client.request<{ id: number }[]>("/posts", {
    responseMode: "full",
  });
  expectTypeOf(full).toEqualTypeOf<ApiResponse<{ id: number }[]>>();
  expect(full.data).toEqual([{ id: 1 }]);
  expect(full.headers.get("x-total-count")).toBe("42");
  expect(full.status).toBe(201);
  expect(full.statusText).toBe("Created");
  expect(full.url).toBe("");
  expect(Object.isFrozen(full)).toBe(true);
});
it("returns a separate native Headers snapshot and missing headers remain null", async () => {
  const response = json({ id: 1 }, { headers: { "x-total-count": "5" } });
  const full = await createApiClient({ fetch: async () => response }).request(
    "/",
    { responseMode: "full" },
  );
  full.headers.set("x-total-count", "changed");
  expect(response.headers.get("x-total-count")).toBe("5");
  expect(full.headers.get("missing")).toBeNull();
});
it("preserves null empty bodies and metadata for 204", async () => {
  const result = await createApiClient({
    fetch: async () =>
      new Response(null, { status: 204, headers: { "x-total-count": "0" } }),
  }).request("/", { responseMode: "full" });
  expect(result.data).toBeNull();
  expect(result.status).toBe(204);
  expect(result.headers.get("X-Total-Count")).toBe("0");
});
it("validates/transforms data before returning metadata, with inferred output", async () => {
  const promise = createApiClient({
    fetch: async () => json({ id: 1 }),
  }).request("/", {
    responseMode: "full",
    schema: (value: unknown) => {
      if (!value || typeof value !== "object" || !("id" in value))
        throw Error("id required");
      return { id: String(value.id) };
    },
  });
  expectTypeOf(promise).toEqualTypeOf<Promise<ApiResponse<{ id: string }>>>();
  expect((await promise).data).toEqual({ id: "1" });
});
it("retains HTTP and schema error semantics in full mode", async () => {
  await expect(
    createApiClient({
      fetch: async () =>
        json({ errors: { title: ["Required"] } }, { status: 422 }),
    }).request("/", { responseMode: "full" }),
  ).rejects.toMatchObject({
    code: "http",
    status: 422,
    fieldErrors: { title: ["Required"] },
  });
  await expect(
    createApiClient({ fetch: async () => json({}) }).request("/", {
      responseMode: "full",
      schema: () => {
        throw Error("bad shape");
      },
    }),
  ).rejects.toMatchObject({ code: "validation" });
});
it("reports metadata from the final response after token refresh", async () => {
  const client = createApiClient({
    session: { userId: "a", token: "old" },
    refreshToken: async () => "new",
    fetch: async (_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer new"
        ? json([1], { headers: { "x-total-count": "11" } })
        : json(
            {},
            {
              status: 401,
              headers: { "x-total-count": "invalid-first-response" },
            },
          ),
  });
  const result = await client.request("/", { responseMode: "full" });
  expect(result.data).toEqual([1]);
  expect(result.status).toBe(200);
  expect(result.headers.get("x-total-count")).toBe("11");
});
it("applies the existing deadline through full-mode body reading", async () => {
  vi.useFakeTimers();
  const response = json({});
  vi.spyOn(response, "text").mockImplementation(
    () => new Promise<string>(() => {}),
  );
  const result = expect(
    createApiClient({ fetch: async () => response, timeoutMs: 10 }).request(
      "/",
      { responseMode: "full" },
    ),
  ).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(10);
  await result;
});
it("types a dynamic response mode as a safe union", async () => {
  const options: RequestOptions<{ id: number }> = {
    responseMode: Math.random() > 0.5 ? "data" : "full",
  };
  const result = createApiClient({
    fetch: async () => json({ id: 1 }),
  }).request("/", options);
  expectTypeOf(result).toEqualTypeOf<
    Promise<{ id: number } | null | ApiResponse<{ id: number }>>
  >();
  await result;
});
it("rejects invalid JS response modes before transport", async () => {
  const fetch = vi.fn();
  await expect(
    createApiClient({ fetch }).request("/", { responseMode: "raw" as "full" }),
  ).rejects.toBeInstanceOf(ApiError);
  expect(fetch).not.toHaveBeenCalled();
});
