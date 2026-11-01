import { describe, it, expect, vi } from "vitest";
import { createApiClient } from "../src/core";
describe("transport", () => {
  it("serializes parameters, maps bodies and reads current auth", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        }),
    );
    let token = "one";
    const client = createApiClient({
      baseUrl: "/api/",
      getToken: () => token,
      fetch: fetcher,
    });
    await client.request("/users", {
      params: { q: "a b", ids: [1, 2] },
      method: "POST",
      body: { name: "A" },
    });
    token = "two";
    await client.request("/users");
    expect((fetcher.mock.calls as any)[0][0]).toBe(
      "/api/users?q=a+b&ids=1&ids=2",
    );
    expect((fetcher.mock.calls as any)[1][1].headers.get("authorization")).toBe(
      "Bearer two",
    );
  });
  it("normalizes validation", async () => {
    const client = createApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            message: "Invalid",
            errors: { email: ["Required"] },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(client.request("/")).rejects.toMatchObject({
      status: 422,
      fieldErrors: { email: ["Required"] },
    });
  });
  it.each(["timeout", "cancelled"])("handles %s", async (code) => {
    const controller = new AbortController();
    const client = createApiClient({
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) reject(new Error("abort"));
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("abort")),
          );
        }),
    });
    const result = client.request("/", {
      signal: controller.signal,
      timeoutMs: code === "timeout" ? 5 : undefined,
    });
    if (code === "cancelled") controller.abort();
    await expect(result).rejects.toMatchObject({ code });
  });
});
