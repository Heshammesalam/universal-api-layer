import {
  DestroyRef,
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  signal,
  type EnvironmentProviders,
  type Signal,
} from "@angular/core";
import { Observable, type Subscriber } from "rxjs";
import {
  ApiError,
  type ApiClient,
  type ApiResponse,
  type RequestOptions,
  type StreamOptions,
  type ServerSentEvent,
  type SessionSnapshot,
} from "../core";

export const API_CLIENT = new InjectionToken<ApiClient>(
  "universal-api-layer client",
);
/** Factories run in the injector, allowing request-local clients during SSR. */
export function provideApiClient(
  value: ApiClient | (() => ApiClient),
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: API_CLIENT,
      ...(typeof value === "function"
        ? { useFactory: value }
        : { useValue: value }),
    },
    {
      provide: ApiService,
      useFactory: () => {
        const service = new ApiService(injectApiClient());
        inject(DestroyRef).onDestroy(() => service.dispose());
        return service;
      },
    },
  ]);
}
export function injectApiClient(): ApiClient {
  return inject(API_CLIENT);
}
export function injectApiSession(
  client: ApiClient = injectApiClient(),
): Signal<SessionSnapshot> {
  const destroy = inject(DestroyRef);
  const state = signal(client.getSessionSnapshot());
  destroy.onDestroy(
    client.subscribeSession(() => state.set(client.getSessionSnapshot())),
  );
  return state.asReadonly();
}

/** Cold, cancellable RxJS transport. This is not Angular HttpClient or a query cache. */
export class ApiService {
  private readonly lifetime = new AbortController();
  constructor(readonly client: ApiClient) {}
  /** Automatically called when the providing injector is destroyed. */
  dispose(): void {
    this.lifetime.abort(
      new ApiError(
        "Angular API provider destroyed",
        0,
        {},
        undefined,
        "cancelled",
      ),
    );
  }
  private operation<T>(
    external: AbortSignal | undefined,
    work: (
      signal: AbortSignal,
      subscriber: Subscriber<T>,
      revision: number,
    ) => Promise<void>,
  ): Observable<T> {
    return new Observable<T>((subscriber) => {
      const revision = this.client.getSessionSnapshot().revision;
      const controller = new AbortController();
      const signals = [this.lifetime.signal, external].filter(
        (value): value is AbortSignal => value !== undefined,
      );
      const cleanups = signals.map((source) => {
        const abort = () => controller.abort(source.reason);
        if (source.aborted) abort();
        else source.addEventListener("abort", abort, { once: true });
        return () => source.removeEventListener("abort", abort);
      });
      void Promise.resolve()
        .then(async () => {
          if (subscriber.closed) return;
          if (controller.signal.aborted)
            throw new ApiError(
              "Angular API operation cancelled",
              0,
              {},
              undefined,
              "cancelled",
              controller.signal.reason,
            );
          this.client.assertSession(revision);
          await work(controller.signal, subscriber, revision);
          this.client.assertSession(revision);
          if (!subscriber.closed) subscriber.complete();
        })
        .catch((error: unknown) => {
          if (!subscriber.closed) subscriber.error(error);
        });
      return () => {
        for (const cleanup of cleanups) cleanup();
        controller.abort(
          new ApiError(
            "Angular API subscription cancelled",
            0,
            {},
            undefined,
            "cancelled",
          ),
        );
      };
    });
  }
  request$<T = unknown>(
    url: string,
    options: RequestOptions<T> & { responseMode: "full" },
  ): Observable<ApiResponse<T>>;
  request$<T = unknown>(
    url: string,
    options?: RequestOptions<T> & { responseMode?: "data" },
  ): Observable<T | null>;
  request$<T = unknown>(
    url: string,
    options: RequestOptions<T>,
  ): Observable<T | null | ApiResponse<T>>;
  request$<T = unknown>(
    url: string,
    options: RequestOptions<T> = {},
  ): Observable<T | null | ApiResponse<T>> {
    return this.operation(
      options.signal,
      async (signal, subscriber, revision) => {
        const result = await this.client.request(url, { ...options, signal });
        this.client.assertSession(revision);
        if (!subscriber.closed) subscriber.next(result);
      },
    );
  }
  stream$(
    url: string,
    options: StreamOptions & { format: "sse" },
  ): Observable<ServerSentEvent>;
  stream$(
    url: string,
    options?: StreamOptions & { format?: "text" },
  ): Observable<string>;
  stream$(
    url: string,
    options: StreamOptions,
  ): Observable<string | ServerSentEvent>;
  stream$(
    url: string,
    options: StreamOptions = {},
  ): Observable<string | ServerSentEvent> {
    return this.operation(
      options.signal,
      async (signal, subscriber, revision) => {
        for await (const value of this.client.stream(url, {
          ...options,
          signal,
        })) {
          if (subscriber.closed) break;
          this.client.assertSession(revision);
          subscriber.next(value);
          if (subscriber.closed) break;
        }
      },
    );
  }
}
