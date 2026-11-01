import type { ApiError, FieldErrors } from "./errors";
import type { ApiClient } from "./client";
import type { Params, ApiHeaders, MutationConfig } from "./types";
import { invokeCallback } from "./callbacks";
export function laravelErrors(data: unknown): FieldErrors {
  if (
    !data ||
    typeof data !== "object" ||
    !("errors" in data) ||
    !data.errors ||
    typeof data.errors !== "object"
  )
    return {};
  return Object.fromEntries(
    Object.entries(data.errors).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String) : [String(value)],
    ]),
  );
}
export function queryIdentity(
  client: ApiClient,
  key: readonly unknown[],
  url: string,
  params?: Params,
  headers?: ApiHeaders,
  scope?: string,
) {
  return client.queryKey(key, url, params, headers, scope);
}
export async function runMutation<T, V, S = T | null>(
  client: ApiClient,
  config: MutationConfig<T, V, S>,
  variables: V,
): Promise<S> {
  const revision = client.getSessionSnapshot().revision;
  const url = invokeCallback(() =>
    typeof config.url === "function" ? config.url(variables) : config.url,
  );
  const body = invokeCallback(() =>
    config.mapPayload ? config.mapPayload(variables) : variables,
  );
  client.assertSession(revision);
  const response = await client.request<T>(url, {
    method: config.method ?? "POST",
    schema: config.schema,
    requiresAuth: config.requiresAuth,
    authRetry: config.authRetry,
    body,
    headers: config.headers,
    signal: config.signal,
    timeoutMs: config.timeoutMs,
  });
  client.assertSession(revision);
  const selected = config.select
    ? invokeCallback(() => config.select!(response))
    : (response as unknown as S);
  client.assertSession(revision);
  return selected;
}

/** Avoid retries for deterministic schema/auth/client failures; honor adapter or QueryClient overrides. */
export function defaultQueryRetry(failureCount: number, error: ApiError) {
  return (
    failureCount < 3 &&
    (error.code === "network" ||
      error.code === "timeout" ||
      (error.code === "http" && error.status >= 500))
  );
}
