import {
  Component,
  DestroyRef,
  afterNextRender,
  inject,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { finalize } from "rxjs";
import { ApiService, injectApiSession } from "universal-api-layer/angular";

interface User {
  id: number;
  name: string;
}
@Component({
  selector: "app-root",
  standalone: true,
  template: `
    <h1>Angular API example</h1>
    <p>Session: {{ session().userId ?? "public" }}</p>
    <button (click)="load()" [disabled]="pending()">Reload</button>
    <button (click)="add()" [disabled]="pending()">Add user</button>
    @if (pending()) {
      <p role="status">Loading...</p>
    }
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    <ul>
      @for (user of users(); track user.id) {
        <li>{{ user.name }}</li>
      }
    </ul>
  `,
})
export class AppComponent {
  private readonly api = inject(ApiService);
  private readonly destroy = inject(DestroyRef);
  readonly session = injectApiSession();
  readonly users = signal<User[]>([]);
  readonly pending = signal(false);
  readonly error = signal("");
  constructor() {
    this.destroy.onDestroy(
      this.api.client.subscribeSession(() => this.users.set([])),
    );
    afterNextRender(() => this.load());
  }
  load() {
    if (this.pending()) return;
    this.pending.set(true);
    this.error.set("");
    this.api
      .request$("/users", {
        schema(value: unknown) {
          if (
            !Array.isArray(value) ||
            value.some(
              (user) =>
                !user ||
                typeof user.id !== "number" ||
                typeof user.name !== "string",
            )
          )
            throw Error("Invalid users");
          return value as User[];
        },
      })
      .pipe(
        takeUntilDestroyed(this.destroy),
        finalize(() => this.pending.set(false)),
      )
      .subscribe({
        next: (value) => this.users.set(value ?? []),
        error: (cause) =>
          this.error.set(
            cause instanceof Error ? cause.message : "Request failed",
          ),
      });
  }
  add() {
    if (this.pending()) return;
    this.pending.set(true);
    this.error.set("");
    this.api
      .request$("/users", { method: "POST", body: { name: "Added Angular" } })
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: () => {
          this.pending.set(false);
          this.load();
        },
        error: (cause) => {
          this.pending.set(false);
          this.error.set(
            cause instanceof Error ? cause.message : "Mutation failed",
          );
        },
      });
  }
}
