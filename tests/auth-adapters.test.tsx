// @vitest-environment jsdom
import React, { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { defineComponent, h } from "vue";
import {
  QueryClient as ReactCache,
  onlineManager,
} from "@tanstack/react-query";
import { QueryClient as VueCache } from "@tanstack/vue-query";
import { createApiClient, type ApiClient } from "../src/core";
import * as react from "../src/react";
import * as vue from "../src/vue";
import { mount } from "./vue-harness";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const disposers: (() => void)[] = [];
afterEach(() => {
  onlineManager.setOnline(true);
  for (const dispose of disposers.splice(0).reverse()) dispose();
  cleanup();
});
function app(
  framework: "react" | "vue",
  client: ApiClient,
  options: { query?: any; mutation?: any; cache?: any; strict?: boolean } = {},
) {
  const cache =
    options.cache ??
    (framework === "react"
      ? new ReactCache({ defaultOptions: { queries: { retry: false } } })
      : new VueCache({ defaultOptions: { queries: { retry: false } } }));
  const query = {
    key: ["private"],
    url: "/me",
    requiresAuth: true,
    staleTime: Infinity,
    ...options.query,
  };
  const mutation = { url: "/write", requiresAuth: true, ...options.mutation };
  if (framework === "react") {
    const hook = renderHook(
      () => ({
        query: react.useApiQuery<any, any>(query),
        mutation: react.useApiMutation<any, any, any>(mutation),
        session: react.useApiSession(),
      }),
      {
        wrapper: ({ children }) =>
          options.strict ? (
            <StrictMode>
              <react.ApiProvider client={client} queryClient={cache}>
                {children}
              </react.ApiProvider>
            </StrictMode>
          ) : (
            <react.ApiProvider client={client} queryClient={cache}>
              {children}
            </react.ApiProvider>
          ),
      },
    );
    disposers.push(() => {
      hook.unmount();
      if (!options.cache) cache.clear();
    });
    return { cache, read: () => hook.result.current };
  }
  let result: any;
  const wrapper = mount(
    defineComponent({
      setup() {
        const queryResult = vue.useApiQuery<any, any>(query),
          mutationResult = vue.useApiMutation<any, any, any>(mutation),
          session = vue.useApiSession();
        result = () => ({
          query: {
            data: queryResult.data.value,
            error: queryResult.error.value,
            isSuccess: queryResult.isSuccess.value,
          },
          mutation: {
            data: mutationResult.data.value,
            error: mutationResult.error.value,
            variables: mutationResult.variables.value,
            status: mutationResult.status.value,
            isPaused: mutationResult.isPaused.value,
            mutate: mutationResult.mutate,
            mutateAsync: mutationResult.mutateAsync,
          },
          session: session.value,
        });
        return () => h("div");
      },
    }),
    {
      global: {
        plugins: [vue.createApiPlugin({ client, queryClient: cache })],
      },
    },
  );
  disposers.push(() => {
    wrapper.unmount();
    if (!options.cache) cache.clear();
  });
  return { cache, read: () => result() };
}
for (const framework of ["react", "vue"] as const) {
  it(`${framework}: removes restored stale data when the session changed before cache binding`, async () => {
    const client = createApiClient({
      session: { userId: "a", token: "a" },
      fetch: async () => json("PRIVATE_B"),
    });
    const cache: any =
      framework === "react" ? new ReactCache() : new VueCache();
    disposers.push(() => cache.clear());
    const oldKey = client.queryKey(["private"], "/me");
    cache.setQueryData(oldKey, "PRIVATE_A");
    client.setSession({ userId: "b", token: "b" });
    const ui = app(framework, client, { cache });
    await waitFor(() => expect(ui.read().query.data).toBe("PRIVATE_B"));
    expect(cache.getQueryData(oldKey)).toBeUndefined();
  });

  it(`${framework}: changes users automatically, clears private data on logout, and preserves other cache namespaces`, async () => {
    const client = createApiClient({
      session: { userId: "a", token: "A_TOKEN" },
      fetch: async (_url, init) =>
        json(
          new Headers(init?.headers).get("authorization") === "Bearer A_TOKEN"
            ? "PRIVATE_A"
            : "PRIVATE_B",
        ),
    });
    const ui = app(framework, client);
    ui.cache.setQueryData(["unrelated"], "KEEP_ME");
    await waitFor(() => expect(ui.read().query.data).toBe("PRIVATE_A"));
    await act(async () => client.setSession({ userId: "b", token: "B_TOKEN" }));
    await waitFor(() => expect(ui.read().query.data).toBe("PRIVATE_B"));
    expect(
      JSON.stringify(
        ui.cache
          .getQueryCache()
          .getAll()
          .map((q: any) => q.state.data),
      ),
    ).not.toContain("PRIVATE_A");
    await act(async () => client.logout());
    await waitFor(() => expect(ui.read().query.data).toBeUndefined());
    expect(ui.read().session.userId).toBeNull();
    expect(ui.cache.getQueryData(["unrelated"])).toBe("KEEP_ME");
    expect(
      JSON.stringify(
        ui.cache
          .getQueryCache()
          .getAll()
          .map((q: any) => q.state.data),
      ),
    ).not.toContain("PRIVATE_B");
  });
  it(`${framework}: token rotation for the same user preserves fresh query data`, async () => {
    const fetch = vi.fn(async () => json("same-account"));
    const client = createApiClient({
      session: { userId: "a", token: "one" },
      fetch,
    });
    const ui = app(framework, client);
    await waitFor(() => expect(ui.read().query.data).toBe("same-account"));
    await act(async () => client.setSession({ userId: "a", token: "two" }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(ui.read().query.data).toBe("same-account");
  });
  it(`${framework}: purges successful mutation data, variables and cached mutations on logout`, async () => {
    const client = createApiClient({
      session: { userId: "a", token: "a" },
      fetch: async (_url, init) =>
        json(init?.method === "POST" ? "PRIVATE_WRITE" : "PRIVATE_QUERY"),
    });
    const ui = app(framework, client);
    await waitFor(() => expect(ui.read().query.isSuccess).toBe(true));
    await act(async () => {
      await ui.read().mutation.mutateAsync({ secret: "PRIVATE_INPUT" });
    });
    await waitFor(() => expect(ui.read().mutation.data).toBe("PRIVATE_WRITE"));
    await act(async () => client.logout());
    await waitFor(() => expect(ui.read().mutation.data).toBeUndefined());
    expect(ui.read().mutation.variables).toBeUndefined();
    expect(ui.read().mutation.status).toBe("idle");
    expect(ui.cache.getMutationCache().getAll()).toHaveLength(0);
  });
  it(`${framework}: cancels late mutations and suppresses their callbacks after switching accounts`, async () => {
    const gate = deferred<Response>();
    const onSuccess = vi.fn(),
      perCall = vi.fn();
    let writes = 0;
    const client = createApiClient({
      session: { userId: "a", token: "a" },
      fetch: async (_url, init) => {
        if (init?.method === "POST") {
          writes++;
          return gate.promise;
        }
        return json("query");
      },
    });
    const ui = app(framework, client, { mutation: { onSuccess } });
    await waitFor(() => expect(ui.read().query.isSuccess).toBe(true));
    const pending = expect(
      ui.read().mutation.mutateAsync({ id: 1 }, { onSuccess: perCall }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await waitFor(() => expect(writes).toBe(1));
    await act(async () => client.setSession({ userId: "b", token: "b" }));
    await pending;
    gate.resolve(json("PRIVATE_A"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(perCall).not.toHaveBeenCalled();
    expect(ui.read().mutation.data).toBeUndefined();
    expect(ui.cache.getMutationCache().getAll()).toHaveLength(0);
  });
  it(`${framework}: logout settles an offline paused mutateAsync without later sending it`, async () => {
    let writes = 0;
    const client = createApiClient({
      session: { userId: "a", token: "a" },
      fetch: async (_url, init) => {
        if (init?.method === "POST") writes++;
        return json("ok");
      },
    });
    const ui = app(framework, client);
    await waitFor(() => expect(ui.read().query.isSuccess).toBe(true));
    onlineManager.setOnline(false);
    const pending = expect(
      ui.read().mutation.mutateAsync({ id: 1 }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await waitFor(() => expect(ui.read().mutation.isPaused).toBe(true));
    await act(async () => client.logout());
    await pending;
    onlineManager.setOnline(true);
    await waitFor(() => expect(ui.read().mutation.status).toBe("idle"));
    expect(writes).toBe(0);
    expect(ui.read().mutation.isPaused).toBe(false);
  });
  it(`${framework}: bounded refresh failure clears the identified session and its cached data`, async () => {
    let expired = false;
    const client = createApiClient({
      session: { userId: "a", token: "old" },
      refreshToken: async () => {
        throw Error("refresh expired");
      },
      fetch: async () => (expired ? json({}, 401) : json("PRIVATE_CACHE")),
    });
    const ui = app(framework, client);
    await waitFor(() => expect(ui.read().query.data).toBe("PRIVATE_CACHE"));
    expired = true;
    await expect(client.request("/other")).rejects.toMatchObject({
      code: "auth",
    });
    await waitFor(() => expect(ui.read().session.userId).toBeNull());
    await waitFor(() => expect(ui.read().query.data).toBeUndefined());
    expect(
      JSON.stringify(
        ui.cache
          .getQueryCache()
          .getAll()
          .map((q: any) => q.state.data),
      ),
    ).not.toContain("PRIVATE_CACHE");
  });
  it(`${framework}: validates queries and mutations before selection or caching`, async () => {
    const client = createApiClient({
      session: { userId: "a" },
      fetch: async () => json({ bad: true }),
    });
    const select = vi.fn();
    const cache: any =
      framework === "react" ? new ReactCache() : new VueCache();
    disposers.push(() => cache.clear());
    const schema = () => {
      throw Error("wrong shape");
    };
    const ui = app(framework, client, {
      query: { schema, select },
      mutation: { schema },
      cache,
    });
    await waitFor(() => expect(ui.read().query.error?.code).toBe("validation"));
    expect(select).not.toHaveBeenCalled();
    await act(async () => {
      await expect(ui.read().mutation.mutateAsync({})).rejects.toMatchObject({
        code: "validation",
      });
    });
    expect(ui.read().query.data).toBeUndefined();
    expect(ui.read().mutation.data).toBeUndefined();
  });
  it(`${framework}: keeps public mutation callbacks and variables unwrapped`, async () => {
    const client = createApiClient({
      session: { userId: "a" },
      fetch: async () => json("ok"),
    });
    const ui = app(framework, client);
    await waitFor(() => expect(ui.read().query.isSuccess).toBe(true));
    const onSuccess = vi.fn(),
      onSettled = vi.fn();
    await act(async () => {
      await ui.read().mutation.mutateAsync({ id: 1 }, { onSuccess, onSettled });
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(onSuccess.mock.calls[0].slice(0, 2)).toEqual(["ok", { id: 1 }]);
    expect(onSettled.mock.calls[0].slice(0, 3)).toEqual([
      "ok",
      null,
      { id: 1 },
    ]);
    expect(ui.read().mutation.variables).toEqual({ id: 1 });
  });
}
it("React: managed authentication survives StrictMode effects", async () => {
  const client = createApiClient({
    session: { userId: "a" },
    fetch: async () => json("ok"),
  });
  const ui = app("react", client, { strict: true });
  await waitFor(() => expect(ui.read().query.data).toBe("ok"));
  await act(async () => client.logout());
  await waitFor(() => expect(ui.read().query.data).toBeUndefined());
  await act(async () => client.setSession({ userId: "b" }));
  await waitFor(() => expect(ui.read().query.data).toBe("ok"));
});
