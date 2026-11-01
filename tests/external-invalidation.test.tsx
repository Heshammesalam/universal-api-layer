// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { defineComponent, h } from "vue";
import {
  QueryClient as ReactCache,
  useQuery as useReactQuery,
} from "@tanstack/react-query";
import {
  QueryClient as VueCache,
  useQuery as useVueQuery,
} from "@tanstack/vue-query";
import { createApiClient } from "../src/core";
import * as react from "../src/react";
import * as vue from "../src/vue";
import { mount } from "./vue-harness";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  cleanup();
});
for (const framework of ["react", "vue"] as const)
  for (const invalidateScope of ["client", "all"] as const)
    it(`${framework}: ${invalidateScope} invalidation with native queries after POST and DELETE`, async () => {
      let posts = [
        { id: 1, title: "one" },
        { id: 2, title: "two" },
      ];
      let nativeReads = 0;
      const client = createApiClient({
        fetch: async (url, init) => {
          if (init?.method === "POST") {
            const created = { id: 3, title: "three" };
            posts.push(created);
            return new Response(JSON.stringify(created), {
              headers: { "content-type": "application/json" },
            });
          }
          if (init?.method === "DELETE") {
            posts = posts.filter(
              (post) => post.id !== Number(String(url).split("/").at(-1)),
            );
            return new Response(null, { status: 204 });
          }
          return new Response(JSON.stringify(posts), {
            headers: {
              "content-type": "application/json",
              "X-Total-Count": String(posts.length),
            },
          });
        },
      });
      const nativeFn = async () => {
        nativeReads++;
        const response = await client.request<{ id: number; title: string }[]>(
          "/posts",
          { responseMode: "full" },
        );
        return {
          posts: response.data,
          total: Number(response.headers.get("X-Total-Count")),
        };
      };
      const mutation = {
        url: "/posts",
        invalidateKeys: [["posts"]],
        invalidateScope,
      };
      const deletion = {
        ...mutation,
        url: (id: number) => `/posts/${id}`,
        method: "DELETE",
        mapPayload: () => undefined,
      };
      let read: any;
      let cache: any;
      if (framework === "react") {
        cache = new ReactCache({
          defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        });
        const hook = renderHook(
          () => ({
            native: useReactQuery({
              queryKey: ["posts", "native"],
              queryFn: nativeFn,
            }),
            owned: react.useApiQuery<{ id: number; title: string }[]>({
              key: ["posts"],
              url: "/posts",
            }),
            add: react.useApiMutation(mutation),
            remove: react.useApiMutation<unknown, number>(deletion),
          }),
          {
            wrapper: ({ children }) => (
              <react.ApiProvider client={client} queryClient={cache}>
                {children}
              </react.ApiProvider>
            ),
          },
        );
        read = () => hook.result.current;
        disposers.push(() => {
          hook.unmount();
          cache.clear();
        });
      } else {
        cache = new VueCache({
          defaultOptions: { queries: { retry: false, staleTime: Infinity } },
        });
        let values: any;
        const wrapper = mount(
          defineComponent({
            setup() {
              const native = useVueQuery({
                  queryKey: ["posts", "native"],
                  queryFn: nativeFn,
                }),
                owned = vue.useApiQuery<{ id: number; title: string }[]>({
                  key: ["posts"],
                  url: "/posts",
                }),
                add = vue.useApiMutation(mutation),
                remove = vue.useApiMutation<unknown, number>(deletion);
              values = () => ({
                native: { data: native.data.value },
                owned: { data: owned.data.value },
                add,
                remove,
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
        read = () => values();
        disposers.push(() => {
          wrapper.unmount();
          cache.clear();
        });
      }
      cache.setQueryData(["unrelated"], "preserved");
      await waitFor(() => expect(read().native.data?.total).toBe(2));
      await waitFor(() => expect(read().owned.data).toHaveLength(2));
      await act(async () => {
        await read().add.mutateAsync({ title: "three" });
      });
      await waitFor(() => expect(read().owned.data).toHaveLength(3));
      if (invalidateScope === "all") {
        await waitFor(() => expect(read().native.data?.total).toBe(3));
        expect(read().native.data.posts).toHaveLength(3);
      } else {
        expect(read().native.data.total).toBe(2);
        expect(nativeReads).toBe(1);
      }
      await act(async () => {
        await read().remove.mutateAsync(3);
      });
      await waitFor(() => expect(read().owned.data).toHaveLength(2));
      await waitFor(() => expect(read().native.data?.total).toBe(2));
      expect(nativeReads).toBe(invalidateScope === "all" ? 3 : 1);
      expect(cache.getQueryData(["unrelated"])).toBe("preserved");
      expect(cache.getQueryState(["unrelated"]).isInvalidated).toBe(false);
    });
