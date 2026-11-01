import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
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
  type SessionSnapshot,
} from "../core/index";
const Context = createContext<{
  client: ApiClient;
  session: SessionSnapshot;
} | null>(null);
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
export function ApiProvider({
  client,
  queryClient,
  children,
}: {
  client: ApiClient;
  queryClient?: QueryClient;
  children: ReactNode;
}) {
  const [owned] = useState(() => queryClient ?? new QueryClient());
  const cache = queryClient ?? owned;
  const session = useSyncExternalStore(
    client.subscribeSession,
    client.getSessionSnapshot,
    client.getSessionSnapshot,
  );
  useEffect(() => bindCache(client, cache), [client, cache]);
  const value = useMemo(() => ({ client, session }), [client, session]);
  return (
    <Context.Provider value={value}>
      <QueryClientProvider client={cache}>{children}</QueryClientProvider>
    </Context.Provider>
  );
}
function useContextValue() {
  const value = useContext(Context);
  if (!value) throw new Error("Wrap your application in ApiProvider");
  return value;
}
export function useApiClient(): ApiClient {
  return useContextValue().client;
}
export function useApiSession(): SessionSnapshot {
  return useContextValue().session;
}
export function useApiQuery<T = unknown, S = T | null>(
  config: QueryConfig<T, S>,
): UseQueryResult<S, ApiError> {
  const { client, session } = useContextValue();
  const cache = useQueryClient();
  return useQuery<T | null, ApiError, S>({
    queryKey: queryIdentity(
      client,
      config.key,
      config.url,
      config.params,
      config.headers,
      config.cacheScope,
    ),
    queryFn: ({ signal }) => {
      client.assertSession(session.revision);
      return client.request<T>(config.url, {
        params: config.params,
        headers: config.headers,
        timeoutMs: config.timeoutMs,
        signal,
        schema: config.schema,
        authRetry: config.authRetry,
        requiresAuth: config.requiresAuth,
      });
    },
    select: config.select
      ? (data) => invokeCallback(() => config.select!(data))
      : undefined,
    enabled: config.requiresAuth
      ? !!session.userId && config.enabled !== false
      : config.enabled,
    staleTime: config.staleTime,
    retry:
      config.retry ??
      cache.getDefaultOptions().queries?.retry ??
      defaultQueryRetry,
  });
}
export function useApiMutation<T = unknown, V = unknown, S = T | null>(
  config: MutationConfig<T, V, S>,
): UseMutationResult<S, ApiError, V, unknown> {
  const { client, session } = useContextValue();
  const cache = useQueryClient();
  type Envelope = { input: V; revision: number };
  const mutation = useMutation<S, ApiError, Envelope>({
    mutationKey: ["universal-api-layer", client.cacheScope, session.revision],
    meta: { universalApiLayer: client.cacheScope },
    mutationFn: async (envelope) => {
      client.assertSession(envelope.revision);
      const data = await runMutation(client, config, envelope.input);
      client.assertSession(envelope.revision);
      return data;
    },
    onSuccess: async (data, envelope) => {
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
      await invokeAsyncCallback(() => config.onSuccess?.(data, envelope.input));
      client.assertSession(envelope.revision);
    },
  });
  type CallOptions = Parameters<
    UseMutationResult<S, ApiError, V, unknown>["mutateAsync"]
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
  const current =
    !mutation.variables || mutation.variables.revision === session.revision;
  return {
    ...mutation,
    ...(!current
      ? {
          data: undefined,
          error: null,
          context: undefined,
          status: "idle",
          isIdle: true,
          isPending: false,
          isSuccess: false,
          isError: false,
          isPaused: false,
          submittedAt: 0,
          failureCount: 0,
          failureReason: null,
        }
      : {}),
    variables: current ? mutation.variables?.input : undefined,
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
  } as UseMutationResult<S, ApiError, V, unknown>;
}
