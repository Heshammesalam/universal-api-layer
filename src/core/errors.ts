export type FieldErrors = Record<string, string[]>;
export type ApiErrorCode =
  | "backpressure"
  | "http"
  | "network"
  | "timeout"
  | "cancelled"
  | "auth"
  | "parse"
  | "configuration"
  | "callback"
  | "validation";
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public fieldErrors: FieldErrors = {},
    public data?: unknown,
    public code: ApiErrorCode = "http",
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApiError";
  }
}
