import { ApiError } from "./errors";
export interface ApiSession {
  userId: string;
  token?: string | null;
  tenantId?: string | null;
}
export interface SessionSnapshot {
  readonly userId: string | null;
  readonly tenantId: string | null;
  readonly revision: number;
}
export function createSessionState(initial?: ApiSession | null) {
  let token: string | null = null;
  let snapshot: SessionSnapshot = Object.freeze({
    userId: null,
    tenantId: null,
    revision: 0,
  });
  let tokenVersion = 0;
  const requests = new Set<AbortController>();
  const listeners = new Set<() => void>();
  function validate(value: ApiSession | null) {
    if (
      value !== null &&
      (typeof value !== "object" ||
        typeof value.userId !== "string" ||
        !value.userId.trim() ||
        (value.tenantId != null && typeof value.tenantId !== "string") ||
        (value.token != null &&
          (typeof value.token !== "string" || !value.token.trim())))
    )
      throw new ApiError(
        "Session requires a non-empty userId and valid token/tenantId",
        0,
        {},
        undefined,
        "configuration",
      );
  }
  if (initial !== undefined) validate(initial);
  if (initial) {
    validate(initial);
    token = initial.token ?? null;
    snapshot = Object.freeze({
      userId: initial.userId,
      tenantId: initial.tenantId ?? null,
      revision: 0,
    });
  }
  const getSnapshot = () => snapshot;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const assert = (revision: number) => {
    if (revision !== snapshot.revision)
      throw new ApiError(
        "Authentication session changed",
        0,
        {},
        undefined,
        "cancelled",
      );
  };
  function set(
    value: ApiSession | null,
    reason = new ApiError(
      "Authentication session changed",
      0,
      {},
      undefined,
      "cancelled",
    ),
  ) {
    validate(value);
    const userId = value?.userId ?? null,
      tenantId = value?.tenantId ?? null;
    const changed =
      value === null ||
      userId !== snapshot.userId ||
      tenantId !== snapshot.tenantId;
    if (token !== (value?.token ?? null)) tokenVersion++;
    token = value?.token ?? null;
    if (!changed) return;
    snapshot = Object.freeze({
      userId,
      tenantId,
      revision: snapshot.revision + 1,
    });
    for (const controller of [...requests]) controller.abort(reason);
    const errors: unknown[] = [];
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new ApiError(
        "Session subscriber failed",
        0,
        {},
        undefined,
        "callback",
        new AggregateError(errors),
      );
  }
  return {
    getSnapshot,
    validate,
    subscribe,
    assert,
    set,
    requests,
    getToken: () => token,
    getTokenVersion: () => tokenVersion,
    updateToken(value: string, revision: number, version: number) {
      assert(revision);
      if (version === tokenVersion) {
        token = value;
        tokenVersion++;
      }
    },
  };
}
