import { createRoot } from "react-dom/client";
import { ApiProvider } from "universal-api-layer/react";
import { client } from "./api";
import Example from "./ApiExample";
createRoot(document.getElementById("app")!).render(
  <ApiProvider client={client}>
    <Example />
  </ApiProvider>,
);
