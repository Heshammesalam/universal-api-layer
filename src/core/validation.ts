import { ApiError } from "./errors";
/** Structural Standard Schema v1 support: Zod, Valibot and other compatible schemas need no runtime dependency here. */
export interface StandardSchema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: T; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string }[] }
      | Promise<
          | { readonly value: T; readonly issues?: undefined }
          | { readonly issues: readonly { readonly message: string }[] }
        >;
  };
}
export type ResponseSchema<T> =
  | ((value: unknown) => T | Promise<T>)
  | { parse(value: unknown): T; parseAsync?: (value: unknown) => Promise<T> }
  | StandardSchema<T>;
export async function validateResponse<T>(
  schema: ResponseSchema<T>,
  value: unknown,
  status: number,
): Promise<T> {
  try {
    let output: T;
    if (typeof schema === "function") output = await schema(value);
    else if ("~standard" in schema) {
      const result = await schema["~standard"].validate(value);
      if (result.issues) throw result;
      output = result.value;
    } else if (schema.parseAsync) output = await schema.parseAsync(value);
    else output = schema.parse(value);
    if (output === undefined)
      throw new Error(
        "Response schemas must return a validated value; use null for empty responses",
      );
    return output;
  } catch (cause) {
    throw new ApiError(
      "Response validation failed",
      status,
      {},
      undefined,
      "validation",
      cause,
    );
  }
}
