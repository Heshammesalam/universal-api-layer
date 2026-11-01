import {
  Component,
  DestroyRef,
  afterNextRender,
  inject,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { finalize, type Subscription } from "rxjs";
import { ApiService, injectApiClient } from "universal-api-layer/angular";
import { createSocketClient } from "universal-api-layer/websocket";
import {
  injectSocketMessage,
  injectSocketState,
} from "universal-api-layer/websocket/angular";

@Component({
  selector: "streaming-chat",
  standalone: true,
  template: `
    <button (click)="send()" [disabled]="pending()">Send demo prompt</button>
    <button (click)="stop()" [disabled]="!pending()">Stop</button>
    <pre>{{ answer() }}</pre>
    <p role="alert">{{ error() }}</p>
  `,
})
export class StreamingChatComponent {
  private readonly api = inject(ApiService);
  private readonly destroy = inject(DestroyRef);
  private active?: Subscription;
  readonly answer = signal("");
  readonly error = signal("");
  readonly pending = signal(false);
  constructor() {
    this.destroy.onDestroy(
      this.api.client.subscribeSession(() => {
        this.stop();
        this.answer.set("");
        this.error.set("");
      }),
    );
  }
  send() {
    this.stop();
    this.answer.set("");
    this.error.set("");
    this.pending.set(true);
    this.active = this.api
      .stream$("/chat", {
        method: "POST",
        body: { message: "Hello" },
        format: "sse",
        timeoutMs: 120_000,
      })
      .pipe(
        takeUntilDestroyed(this.destroy),
        finalize(() => this.pending.set(false)),
      )
      .subscribe({
        next: (event) => {
          if (event.data === "[DONE]") {
            this.stop();
            return;
          }
          try {
            const value: unknown = JSON.parse(event.data);
            if (
              !value ||
              typeof value !== "object" ||
              !("delta" in value) ||
              typeof value.delta !== "string"
            )
              throw Error("Invalid chat event");
            const delta = value.delta;
            this.answer.update((old) => old + delta);
          } catch (cause) {
            this.error.set(
              cause instanceof Error ? cause.message : "Invalid event",
            );
            this.stop();
          }
        },
        error: (cause) =>
          this.error.set(
            cause instanceof Error ? cause.message : "Stream failed",
          ),
      });
  }
  stop() {
    this.active?.unsubscribe();
    this.active = undefined;
  }
}

@Component({
  selector: "socket-chat",
  standalone: true,
  template: `
    <p role="status">{{ state().status }}</p>
    <button (click)="socket.connect()">Connect</button>
    <button (click)="send()" [disabled]="state().status !== 'open'">
      Send demo message
    </button>
    <button (click)="socket.disconnect()">Disconnect</button>
    <p role="alert">{{ error() || state().error?.message }}</p>
    <ul>
      @for (message of messages(); track $index) {
        <li>{{ message }}</li>
      }
    </ul>
  `,
})
export class WebSocketChatComponent {
  private readonly client = injectApiClient();
  private readonly destroy = inject(DestroyRef);
  readonly socket = createSocketClient({
    url: "ws://localhost:3000/chat",
    sessionClient: this.client,
    requiresAuth: false,
    schema(value: unknown) {
      if (
        !value ||
        typeof value !== "object" ||
        !("text" in value) ||
        typeof value.text !== "string"
      )
        throw Error("Invalid message");
      return { text: value.text };
    },
  });
  readonly state = injectSocketState(this.socket);
  readonly messages = signal<string[]>([]);
  readonly error = signal("");
  constructor() {
    injectSocketMessage(this.socket, (value) =>
      this.messages.update((old) => [...old.slice(-99), value.text]),
    );
    this.destroy.onDestroy(
      this.client.subscribeSession(() => this.messages.set([])),
    );
    this.destroy.onDestroy(() => this.socket.dispose());
    afterNextRender(() => this.socket.connect());
  }
  send() {
    try {
      this.socket.sendJson({ type: "chat.send", text: "Hello" });
      this.error.set("");
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : "Send failed");
    }
  }
}
