import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
export async function verifyBrowserConsumer(directory) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(
    readFileSync(join(directory, "dist/index.html"), "utf8"),
    {
      url: "http://consumer.test/",
      runScripts: "outside-only",
      virtualConsole,
    },
  );
  const { window } = dom;
  Object.assign(window, {
    Headers,
    Response,
    Request,
    TextEncoder,
    TextDecoder,
  });
  const users = [{ id: 1, name: "Packed User" }];
  let writes = 0;
  window.fetch = async (url, init) => {
    if (!String(url).startsWith("/api/users"))
      throw new Error(`Unexpected request ${url}`);
    if (init?.method === "POST") {
      writes++;
      if (writes === 1)
        return new Response(
          JSON.stringify({
            message: "Invalid",
            errors: { name: ["Name is required"] },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      users.push({ id: users.length + 1, name: JSON.parse(init.body).name });
      return new Response(JSON.stringify({ data: users.at(-1) }), {
        headers: { "content-type": "application/json" },
      });
    }
    const token = new Headers(init?.headers).get("authorization");
    const data =
      token === "Bearer TOKEN_A"
        ? [{ id: 10, name: "PRIVATE_A" }]
        : token === "Bearer TOKEN_B"
          ? [{ id: 20, name: "PRIVATE_B" }]
          : users;
    return new Response(JSON.stringify({ data }), {
      headers: { "content-type": "application/json" },
    });
  };
  const wait = async (condition, description) => {
    const deadline = Date.now() + 3000;
    while (!condition()) {
      if (errors.length) throw errors[0];
      if (Date.now() > deadline)
        throw new Error(`${description}: ${window.document.body.textContent}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    const asset = window.document
      .querySelector('script[type="module"][src]')
      ?.getAttribute("src");
    if (!asset) throw new Error("Missing built entry point");
    window.eval(
      readFileSync(join(directory, "dist", asset.replace(/^\/+/, "")), "utf8"),
    );
    await wait(
      () => window.document.body.textContent.includes("Packed User"),
      "Packed query did not render",
    );
    window.document
      .querySelector("button")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(
      () => window.document.body.textContent.includes("Name is required"),
      "Validation fields did not render",
    );
    window.document
      .querySelector("button")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait(
      () => window.document.body.textContent.includes("Bahaa"),
      "Mutation invalidation did not refresh the rendered query",
    );
    const client = window.__apiClient;
    client.setSession({ userId: "a", token: "TOKEN_A" });
    await wait(
      () => window.document.body.textContent.includes("PRIVATE_A"),
      "Managed login did not update the packed query",
    );
    client.setSession({ userId: "b", token: "TOKEN_B" });
    await wait(
      () =>
        window.document.body.textContent.includes("PRIVATE_B") &&
        !window.document.body.textContent.includes("PRIVATE_A"),
      "Account switch leaked previous query data",
    );
    client.logout();
    await wait(
      () =>
        window.document.body.textContent.includes("Packed User") &&
        !window.document.body.textContent.includes("PRIVATE_B"),
      "Logout did not remove account data",
    );
    if (errors.length) throw errors[0];
  } finally {
    window.close();
  }
}
