import { provideZonelessChangeDetection } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { createApiClient } from "universal-api-layer";
import { provideApiClient } from "universal-api-layer/angular";
import { AppComponent } from "./app";

void bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideApiClient(() => createApiClient({ baseUrl: "/api" })),
  ],
});
