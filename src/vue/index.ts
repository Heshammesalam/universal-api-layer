import {
  computed,
  inject,
  onScopeDispose,
  shallowRef,
  type InjectionKey,
  type MaybeRefOrGetter,
  type Plugin,
  toValue,
} from "vue";
import {
  QueryClient,
  VueQueryPlugin,
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryReturnType,
  type UseMutationReturnType,
} from "@tanstack/vue-query";
import {
  ApiError,
  queryIdentity,
  runMutation,
  invokeCallback,
  invokeAsyncCallback,
  defaultQueryRetry,
  type ApiClient,
  type QueryConfig,
  type MutationConfig,
} from "../core/index";
const clientKey: InjectionKey<ApiClient> = Symbol("universal-api-layer");
function clearClientCache(
  client: ApiClient,
  cache: QueryClient,
  staleOnly = false,
) {
  const current = client.getSessionSnapshot();
  const predicate = (query: { queryKey: readonly unknown[] }) => {
    if (!client.ownsQuery(query.queryKey)) return false;
    if (!staleOnly) return true;
    const snapshot = (
      query.queryKey.at(-1) as {
        session?: {
          userId: string | null;
          tenantId: string | null;
          revision: number;
        };
      }
    ).session;
    return (
      !snapshot ||
      snapshot.revision !== current.revision ||
      snapshot.userId !== current.userId ||
      snapshot.tenantId !== current.tenantId
    );
  };
  void cache.cancelQueries({ predicate }).catch(() => {});
  cache.removeQueries({ predicate });
  for (const mutation of cache.getMutationCache().getAll()) {
    const variables = mutation.state.variables;
    const revision =
      variables && typeof variables === "object" && "revision" in variables
        ? variables.revision
        : undefined;
    if (
      mutation.options.meta?.universalApiLayer === client.cacheScope &&
      (!staleOnly || revision !== current.revision)
    )
      cache.getMutationCache().remove(mutation);
  }
}
const cacheBindings = new WeakMap<
  ApiClient,
  WeakMap<QueryClient, { count: number; unsubscribe: () => void }>
>();
function bindCache(client: ApiClient, cache: QueryClient) {
  let caches = cacheBindings.get(client);
  if (!caches) {
    caches = new WeakMap();
    cacheBindings.set(client, caches);
  }
  let binding = caches.get(cache);
  if (!binding) {
    clearClientCache(client, cache, true);
    binding = {
      count: 0,
      unsubscribe: client.subscribeSession(() =>
        clearClientCache(client, cache),
      ),
    };
    caches.set(cache, binding);
  }
  binding.count++;
  const current = binding;
  return () => {
    current.count--;
    if (current.count === 0) {
      current.unsubscribe();
      clearClientCache(client, cache);
      caches.delete(cache);
    }
  };
}
export function createApiPlugin({
  client,
  queryClient,
}: {
  client: ApiClient;
  queryClient?: QueryClient;
}): Plugin {
  return {
    install(app) {
      const cache = queryClient ?? new QueryClient();
      app.provide(clientKey, client);
      app.use(VueQueryPlugin, { queryClient: cache });
      const unsubscribe = bindCache(client, cache);
      const unmount = app.unmount.bind(app);
      app.unmount = () => {
        unsubscribe();
        unmount();
      };
    },
  };
}
export function useApiClient(): ApiClient {
  const client = inject(clientKey);
  if (!client)
    throw new Error("Install createApiPlugin before using API composables");
  return client;
}
function useSession(client: ApiClient) {
  const snapshot = shallowRef(client.getSessionSnapshot());
  const unsubscribe = client.subscribeSession(() => {
    snapshot.value = client.getSessionSnapshot();
  });
  onScopeDispose(unsubscribe);
  return computed(() => snapshot.value);
}
export function useApiSession() {
  return useSession(useApiClient());
}
export type VueQueryConfig<T, S = T | null> = Omit<
  QueryConfig<T, S>,
  "key" | "url" | "params" | "enabled" | "cacheScope"
> & {
  key: MaybeRefOrGetter<readonly unknown[]>;
  url: MaybeRefOrGetter<string>;
  params?: MaybeRefOrGetter<QueryConfig<T, S>["params"]>;
  enabled?: MaybeRefOrGetter<boolean>;
  cacheScope?: MaybeRefOrGetter<string>;
};
export function useApiQuery<T = unknown, S = T | null>(
  config: VueQueryConfig<T, S>,
): UseQueryReturnType<S, ApiError> {
  const client = useApiClient();
  const session = useSession(client);
  const cache = useQueryClient();
  return useQuery<T | null, ApiError, S>(
    computed(() => {
      const url = toValue(config.url),
        params = toValue(config.params);
      const snapshot = session.value;
      return {
        queryKey: queryIdentity(
          client,
          toValue(config.key),
          url,
          params,
          config.headers,
          toValue(config.cacheScope),
        ),
        queryFn: ({ signal }: { signal: AbortSignal }) => {
          client.assertSession(snapshot.revision);
          return client.request<T>(url, {
            params,
            headers: config.headers,
            timeoutMs: config.timeoutMs,
            signal,
            schema: config.schema,
            authRetry: config.authRetry,
            requiresAuth: config.requiresAuth,
          });
        },
        select: config.select
          ? (data: T | null) => invokeCallback(() => config.select!(data))
          : undefined,
        enabled: config.requiresAuth
          ? !!snapshot.userId && toValue(config.enabled) !== false
          : toValue(config.enabled),
        staleTime: config.staleTime,
        retry:
          config.retry ??
          cache.getDefaultOptions().queries?.retry ??
          defaultQueryRetry,
      };
    }),
  );
}
export function useApiMutation<T = unknown, V = unknown, S = T | null>(
  config: MutationConfig<T, V, S>,
): UseMutationReturnType<S, ApiError, V, unknown> {
  const client = useApiClient(),
    cache = useQueryClient(),
    session = useSession(client);
  type Envelope = { input: V; revision: number };
  const mutation = useMutation<S, ApiError, Envelope>(
    computed(() => ({
      mutationKey: [
        "universal-api-layer",
        client.cacheScope,
        session.value.revision,
      ],
      meta: { universalApiLayer: client.cacheScope },
      mutationFn: async (envelope: Envelope) => {
        client.assertSession(envelope.revision);
        const data = await runMutation(client, config, envelope.input);
        client.assertSession(envelope.revision);
        return data;
      },
      onSuccess: async (data: S, envelope: Envelope) => {
        client.assertSession(envelope.revision);
        await Promise.all(
          (config.invalidateKeys ?? []).map((queryKey) =>
            cache.invalidateQueries({
              queryKey,
              predicate:
                config.invalidateScope === "all"
                  ? undefined
                  : (query) => client.ownsQuery(query.queryKey),
            }),
          ),
        );
        client.assertSession(envelope.revision);
        await invokeAsyncCallback(() =>
          config.onSuccess?.(data, envelope.input),
        );
        client.assertSession(envelope.revision);
      },
    })),
  );
  type CallOptions = Parameters<
    UseMutationReturnType<S, ApiError, V, unknown>["mutateAsync"]
  >[1];
  const translate = (options: CallOptions) =>
    options
      ? {
          onSuccess: (
            data: S,
            envelope: Envelope,
            context: unknown,
            mutationContext: Parameters<
              NonNullable<NonNullable<CallOptions>["onSuccess"]>
            >[3],
          ) => {
            if (envelope.revision === client.getSessionSnapshot().revision)
              options.onSuccess?.(
                data,
                envelope.input,
                context,
                mutationContext,
              );
          },
          onError: (
            error: ApiError,
            envelope: Envelope,
            context: unknown,
            mutationContext: Parameters<
              NonNullable<NonNullable<CallOptions>["onError"]>
            >[3],
          ) => {
            if (envelope.revision === client.getSessionSnapshot().revision)
              options.onError?.(
                error,
                envelope.input,
                context,
                mutationContext,
              );
          },
          onSettled: (
            data: S | undefined,
            error: ApiError | null,
            envelope: Envelope,
            context: unknown,
            mutationContext: Parameters<
              NonNullable<NonNullable<CallOptions>["onSettled"]>
            >[4],
          ) => {
            if (envelope.revision === client.getSessionSnapshot().revision)
              options.onSettled?.(
                data,
                error,
                envelope.input,
                context,
                mutationContext,
              );
          },
        }
      : undefined;
  const current = computed(
    () =>
      !mutation.variables.value ||
      mutation.variables.value.revision === session.value.revision,
  );
  return {
    ...mutation,
    data: computed(() => (current.value ? mutation.data.value : undefined)),
    error: computed(() => (current.value ? mutation.error.value : null)),
    variables: computed(() =>
      current.value ? mutation.variables.value?.input : undefined,
    ),
    context: computed(() =>
      current.value ? mutation.context.value : undefined,
    ),
    status: computed(() => (current.value ? mutation.status.value : "idle")),
    isPaused: computed(() => current.value && mutation.isPaused.value),
    isIdle: computed(() => !current.value || mutation.isIdle.value),
    isPending: computed(() => current.value && mutation.isPending.value),
    isSuccess: computed(() => current.value && mutation.isSuccess.value),
    isError: computed(() => current.value && mutation.isError.value),
    submittedAt: computed(() =>
      current.value ? mutation.submittedAt.value : 0,
    ),
    failureCount: computed(() =>
      current.value ? mutation.failureCount.value : 0,
    ),
    failureReason: computed(() =>
      current.value ? mutation.failureReason.value : null,
    ),
    mutate: (input: V, options?: CallOptions) =>
      mutation.mutate(
        { input, revision: client.getSessionSnapshot().revision },
        translate(options),
      ),
    mutateAsync: (input: V, options?: CallOptions) =>
      client.withSession(() =>
        mutation.mutateAsync(
          { input, revision: client.getSessionSnapshot().revision },
          translate(options),
        ),
      ),
  } as UseMutationReturnType<S, ApiError, V, unknown>;
}
