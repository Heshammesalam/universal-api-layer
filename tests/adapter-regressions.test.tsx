// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  computed,
  defineComponent,
  h,
  nextTick,
  ref,
  shallowReactive,
} from "vue";
import {
  dehydrate,
  QueryClient as ReactCache,
  useQueryClient,
} from "@tanstack/react-query";
import { QueryClient as VueCache } from "@tanstack/vue-query";
import { ApiError, createApiClient, type ApiClient } from "../src/core";
import * as react from "../src/react";
import * as vue from "../src/vue";
import { mount } from "./vue-harness";
type Framework = "react" | "vue";
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  cleanup();
});
function harness(
  framework: Framework,
  client: ApiClient,
  initial: any,
  sharedCache?: any,
  mutationConfig?: any,
) {
  const cache =
    sharedCache ??
    (framework === "react"
      ? new ReactCache({ defaultOptions: { queries: { retry: false } } })
      : new VueCache({ defaultOptions: { queries: { retry: false } } }));
  if (framework === "react") {
    let activeClient = client;
    const hook = renderHook(
      ({ config }) => ({
        query: react.useApiQuery<any, any>(config),
        mutation: react.useApiMutation<any, any, any>(
          mutationConfig ?? { url: "/" },
        ),
      }),
      {
        initialProps: { config: initial },
        wrapper: ({ children }) => (
          <react.ApiProvider client={activeClient} queryClient={cache}>
            {children}
          </react.ApiProvider>
        ),
      },
    );
    disposers.push(() => {
      hook.unmount();
      if (!sharedCache) cache.clear();
    });
    return {
      cache,
      read: () => hook.result.current.query,
      mutation: () => hook.result.current.mutation,
      update(config: any, nextClient = activeClient) {
        activeClient = nextClient;
        hook.rerender({ config });
      },
    };
  }
  const config = shallowReactive({ ...initial });
  let query: any;
  let mutation: any;
  const wrapper = mount(
    defineComponent({
      setup() {
        query = vue.useApiQuery<any, any>(config);
        mutation = vue.useApiMutation<any, any, any>(
          mutationConfig ?? { url: "/" },
        );
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
    if (!sharedCache) cache.clear();
  });
  return {
    cache,
    read: () => ({
      data: query.data.value,
      error: query.error.value,
      isSuccess: query.isSuccess.value,
      isError: query.isError.value,
    }),
    mutation: () => ({
      mutateAsync: mutation.mutateAsync,
      error: mutation.error.value,
    }),
    update(next: any) {
      Object.assign(config, next);
    },
  };
}
for (const framework of ["react", "vue"] as const) {
  it.each([200, 204])(
    `${framework}: empty %s responses remain successful null data`,
    async (status) => {
      const app = harness(
        framework,
        createApiClient({ fetch: async () => new Response(null, { status }) }),
        { key: ["empty"], url: "/empty" },
      );
      await waitFor(() => expect(app.read().isSuccess).toBe(true));
      expect(app.read().data).toBeNull();
      expect(app.read().error).toBeNull();
    },
  );
  it(`${framework}: cache dehydration contains no credential headers`, async () => {
    const app = harness(
      framework,
      createApiClient({
        headers: { "x-private-key": "DEFAULT_SECRET" },
        fetch: async () => json(["safe"]),
      }),
      {
        key: ["users"],
        url: "/users",
        headers: {
          Authorization: "Bearer AUTH_SECRET",
          Cookie: "COOKIE_SECRET",
          "x-api-key": "API_SECRET",
        },
      },
    );
    await waitFor(() => expect(app.read().isSuccess).toBe(true));
    const serialized = JSON.stringify(dehydrate(app.cache));
    for (const secret of [
      "DEFAULT_SECRET",
      "AUTH_SECRET",
      "COOKIE_SECRET",
      "API_SECRET",
    ])
      expect(serialized).not.toContain(secret);
  });
  it(`${framework}: shared caches isolate clients for different tenants`, async () => {
    const cache = framework === "react" ? new ReactCache() : new VueCache();
    disposers.push(() => cache.clear());
    const config = { key: ["account"], url: "/account", staleTime: Infinity };
    const a = harness(
      framework,
      createApiClient({
        baseUrl: "https://a.example",
        fetch: async () => json("tenant-a"),
      }),
      config,
      cache,
    );
    await waitFor(() => expect(a.read().data).toBe("tenant-a"));
    const b = harness(
      framework,
      createApiClient({
        baseUrl: "https://b.example",
        fetch: async () => json("tenant-b"),
      }),
      config,
      cache,
    );
    await waitFor(() => expect(b.read().data).toBe("tenant-b"));
    expect(a.read().data).toBe("tenant-a");
  });
  it(`${framework}: changing account scope selects an independent cache entry`, async () => {
    let account = "account-a";
    const config = {
      key: ["me"],
      url: "/me",
      cacheScope: account,
      staleTime: Infinity,
    };
    const app = harness(
      framework,
      createApiClient({ fetch: async () => json(account) }),
      config,
    );
    await waitFor(() => expect(app.read().data).toBe("account-a"));
    account = "account-b";
    app.update({ ...config, cacheScope: account });
    await waitFor(() => expect(app.read().data).toBe("account-b"));
  });
  it(`${framework}: selection exceptions have a callback ApiError and original cause`, async () => {
    const cause = new Error("invalid selection");
    const app = harness(
      framework,
      createApiClient({ fetch: async () => json({}) }),
      {
        key: ["select"],
        url: "/",
        select: () => {
          throw cause;
        },
      },
    );
    await waitFor(() => expect(app.read().isError).toBe(true));
    expect(app.read().error).toBeInstanceOf(ApiError);
    expect(app.read().error).toMatchObject({ code: "callback", cause });
  });
  it(`${framework}: token lookup timeout surfaces through hook state`, async () => {
    const app = harness(
      framework,
      createApiClient({
        timeoutMs: 10,
        getToken: () => new Promise<string>(() => {}),
      }),
      { key: ["timeout"], url: "/", retry: false },
    );
    await waitFor(() => expect(app.read().error?.code).toBe("timeout"));
  });
  it(`${framework}: mutation success callback failure is distinct from an HTTP failure`, async () => {
    const cause = new Error("onSuccess failed");
    let requests = 0;
    const app = harness(
      framework,
      createApiClient({
        fetch: async () => {
          requests++;
          return json({});
        },
      }),
      { key: ["disabled"], url: "/", enabled: false },
      undefined,
      {
        url: "/",
        onSuccess: async () => {
          throw cause;
        },
      },
    );
    await act(async () => {
      await expect(app.mutation().mutateAsync({})).rejects.toMatchObject({
        code: "callback",
        cause,
      });
    });
    expect(requests).toBe(1);
    await waitFor(() => expect(app.mutation().error).toBeInstanceOf(ApiError));
  });
}
it("React: owned QueryClient stays stable across renders", () => {
  const client = createApiClient();
  const hook = renderHook(
    () => ({ cache: useQueryClient(), client: react.useApiClient() }),
    {
      wrapper: ({ children }) => (
        <react.ApiProvider client={client}>{children}</react.ApiProvider>
      ),
    },
  );
  const first = hook.result.current.cache;
  hook.rerender();
  expect(hook.result.current.cache).toBe(first);
  expect(hook.result.current.client).toBe(client);
  hook.unmount();
  first.clear();
});
it("React: switching injected clients does not retain previous client data", async () => {
  const config = { key: ["switch"], url: "/", staleTime: Infinity };
  const a = createApiClient({ fetch: async () => json("a") });
  const b = createApiClient({ fetch: async () => json("b") });
  const app = harness("react", a, config);
  await waitFor(() => expect(app.read().data).toBe("a"));
  app.update(config, b);
  await waitFor(() => expect(app.read().data).toBe("b"));
});
it.each(["ref", "computed", "getter"])(
  "Vue: %s parameters and account scopes stay reactive",
  async (mode) => {
    const page = ref(1);
    const params = ref({ page: 1 });
    const account = ref("a");
    const input =
      mode === "ref"
        ? params
        : mode === "computed"
          ? computed(() => ({ page: page.value }))
          : () => ({ page: page.value });
    const app = harness(
      "vue",
      createApiClient({ fetch: async (url) => json(String(url)) }),
      { key: ["reactive"], url: "/users", params: input, cacheScope: account },
    );
    await waitFor(() => expect(app.read().data).toBe("/users?page=1"));
    page.value = 2;
    params.value = { page: 2 };
    account.value = "b";
    await nextTick();
    await waitFor(() => expect(app.read().data).toBe("/users?page=2"));
    expect(JSON.stringify(dehydrate(app.cache))).toContain('"account":"b"');
  },
);
