import { ApiError } from "./errors";
export function abortable<T>(
  operation: () => T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(signal.reason);
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}
export function invokeCallback<T>(callback: () => T): T {
  try {
    return callback();
  } catch (cause) {
    throw new ApiError(
      "API callback failed",
      0,
      {},
      undefined,
      "callback",
      cause,
    );
  }
}
export async function invokeAsyncCallback(
  callback: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await callback();
  } catch (cause) {
    throw new ApiError(
      "API callback failed",
      0,
      {},
      undefined,
      "callback",
      cause,
    );
  }
}
