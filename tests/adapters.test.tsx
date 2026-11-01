// @vitest-environment jsdom
import React from "react";
import { it, expect, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { mount } from "./vue-harness";
import { defineComponent, h, ref, nextTick } from "vue";
import { QueryClient as ReactQueryClient } from "@tanstack/react-query";
import { QueryClient as VueQueryClient } from "@tanstack/vue-query";
import { createApiClient } from "../src/core";
import * as react from "../src/react";
import * as vue from "../src/vue";
for (const framework of ["react", "vue"] as const)
  it(`${framework}: selection, params, dynamic mutation, validation and invalidation`, async () => {
    const mutationController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: any, init: any) => {
      calls.push(String(url));
      if (
        String(url).includes("page=3") ||
        String(url).endsWith("/4") ||
        String(url).endsWith("/5")
      ) {
        requestSignal = init.signal;
        return await new Promise<Response>((_resolve, reject) => {
          if (init.signal.aborted) reject(new Error("abort"));
          init.signal.addEventListener("abort", () =>
            reject(new Error("abort")),
          );
        });
      }
      if (init.method === "PATCH") {
        const body = JSON.parse(init.body);
        return new Response(
          JSON.stringify(
            body.bad
              ? { message: "Invalid", errors: { name: ["Required"] } }
              : { data: { id: 1, name: body.name } },
          ),
          {
            status: body.bad ? 422 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({ data: [{ id: 1, name: String(url) }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const client = createApiClient({
      baseUrl: "/api",
      getToken: () => "token",
      fetch: fetcher,
    });
    let query: any, mutation: any;
    let update: (page: number) => Promise<void>;
    let dispose: () => void;
    let cache: any;
    if (framework === "react") {
      cache = new ReactQueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const hook = renderHook(
        ({ page }) => ({
          query: react.useApiQuery<
            { data: { id: number; name: string }[] },
            { id: number; name: string }[]
          >({
            key: ["users"],
            url: "/users",
            params: { page },
            select: (r) => r?.data ?? [],
          }),
          mutation: react.useApiMutation<any, any>({
            url: (v) => `/users/${v.id}`,
            method: "PATCH",
            mapPayload: (v) => ({ name: v.name, bad: v.bad }),
            invalidateKeys: [["users"]],
            select: (r) => r?.data ?? [],
            timeoutMs: 50,
            signal: mutationController.signal,
          }),
        }),
        {
          initialProps: { page: 1 },
          wrapper: ({ children }) => (
            <react.ApiProvider client={client} queryClient={cache}>
              {children}
            </react.ApiProvider>
          ),
        },
      );
      query = () => hook.result.current.query;
      mutation = () => hook.result.current.mutation;
      update = async (page) => {
        hook.rerender({ page });
      };
      dispose = () => {
        hook.unmount();
        cleanup();
      };
    } else {
      cache = new VueQueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const page = ref(1);
      let q: any, m: any;
      const wrapper = mount(
        defineComponent({
          setup() {
            q = vue.useApiQuery<
              { data: { id: number; name: string }[] },
              { id: number; name: string }[]
            >({
              key: ["users"],
              url: "/users",
              params: () => ({ page: page.value }),
              select: (r) => r?.data ?? [],
            });
            m = vue.useApiMutation<any, any>({
              url: (v) => `/users/${v.id}`,
              method: "PATCH",
              mapPayload: (v) => ({ name: v.name, bad: v.bad }),
              invalidateKeys: [["users"]],
              select: (r) => r?.data ?? [],
              timeoutMs: 50,
              signal: mutationController.signal,
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
      query = () => ({ data: q.data.value, isPending: q.isPending.value });
      mutation = () => ({ mutateAsync: m.mutateAsync, error: m.error.value });
      update = async (value) => {
        page.value = value;
        await nextTick();
      };
      dispose = () => wrapper.unmount();
    }
    try {
      expect(query().isPending).toBe(true);
      await waitFor(() =>
        expect(query().data?.[0].name).toBe("/api/users?page=1"),
      );
      await update(2);
      await waitFor(() =>
        expect(query().data?.[0].name).toBe("/api/users?page=2"),
      );
      const before = calls.length;
      await act(async () => {
        expect(await mutation().mutateAsync({ id: 3, name: "New" })).toEqual({
          id: 1,
          name: "New",
        });
      });
      await waitFor(() => expect(calls.length).toBeGreaterThan(before + 1));
      expect(calls).toContain("/api/users/3");
      await act(async () => {
        await expect(
          mutation().mutateAsync({ id: 3, bad: true }),
        ).rejects.toMatchObject({ fieldErrors: { name: ["Required"] } });
      });
      await waitFor(() =>
        expect(mutation().error?.fieldErrors.name).toEqual(["Required"]),
      );
      await act(async () => {
        await expect(
          mutation().mutateAsync({ id: 4, name: "Slow" }),
        ).rejects.toMatchObject({ code: "timeout" });
      });
      mutationController.abort();
      await act(async () => {
        await expect(mutation().mutateAsync({ id: 5 })).rejects.toMatchObject({
          code: "cancelled",
        });
      });
      await update(3);
      await waitFor(() => expect(calls).toContain("/api/users?page=3"));
      await act(async () => {
        await cache.cancelQueries({ queryKey: ["users"] });
      });
      expect(requestSignal?.aborted).toBe(true);
      expect(
        fetcher.mock.calls.every(
          ([, init]) => init.headers.get("authorization") === "Bearer token",
        ),
      ).toBe(true);
    } finally {
      dispose();
      cache.clear();
    }
  });
