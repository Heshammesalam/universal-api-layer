import { createRequire } from "node:module";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";

export async function verifyAngularConsumers(tar, root, npm, minimum) {
  function command(node, args, cwd = root) {
    const result = spawnSync(node, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20e6,
      timeout: 600_000,
      env: {
        ...process.env,
        PATH: dirname(node) + delimiter + process.env.PATH,
        NG_CLI_ANALYTICS: "false",
        CI: "true",
      },
    });
    if (result.status !== 0)
      throw Error(`${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  }
  let node = process.execPath;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!minimum && (major < 24 || (major === 24 && minor < 15))) {
    node = command(process.execPath, [
      npm,
      "exec",
      "--yes",
      "--package=node@24",
      "--",
      "node",
      "-p",
      "process.execPath",
    ]);
  }
  for (const version of minimum ? ["20.3.34"] : ["21", "22"]) {
    globalThis.console.log(
      `Checking packed Angular ${version} production consumer`,
    );
    const cwd = mkdtempSync(join(tmpdir(), "ual-angular-"));
    cpSync(join(root, "examples/angular"), cwd, {
      recursive: true,
      filter: (path) =>
        !path.includes("node_modules") && !path.includes("dist"),
    });
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    pkg.engines = {
      node:
        version === "22"
          ? "^22.22.3 || ^24.15.0 || >=26.0.0"
          : "^20.19.0 || ^22.12.0 || >=24.0.0",
    };
    pkg.dependencies["universal-api-layer"] = `file:${tar}`;
    for (const name of [
      "@angular/common",
      "@angular/compiler",
      "@angular/core",
      "@angular/platform-browser",
    ])
      pkg.dependencies[name] = version;
    for (const name of ["@angular/build", "@angular/cli"])
      pkg.devDependencies[name] = version.startsWith("20")
        ? "^20.3.0"
        : version;
    pkg.devDependencies["@angular/compiler-cli"] = version;
    pkg.devDependencies.typescript = version === "22" ? "~6.0.0" : "~5.9.0";
    writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg, null, 2));
    command(node, [npm, "install", "--no-audit", "--no-fund"], cwd);
    const require = createRequire(join(cwd, "package.json"));
    for (const unused of [
      "react",
      "vue",
      "@tanstack/react-query",
      "@tanstack/vue-query",
    ]) {
      let installed = false;
      try {
        require.resolve(unused);
        installed = true;
      } catch {
        /* Unused peers must stay absent. */
      }
      if (installed)
        throw Error(`Angular consumer unexpectedly installed ${unused}`);
    }
    // Exercise the published CLI and include its standalone example in AOT checking.
    command(
      node,
      [
        join(cwd, "node_modules/universal-api-layer/dist/cli/index.js"),
        "init",
        "--framework",
        "angular",
      ],
      cwd,
    );
    command(
      node,
      [join(cwd, "node_modules/@angular/cli/bin/ng.js"), "build"],
      cwd,
    );
    const bundle = await build({
      entryPoints: [join(cwd, "dist/app/browser/main.js")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      logLevel: "silent",
    });
    const errors = [];
    const console = new VirtualConsole();
    console.on("jsdomError", (error) => errors.push(error));
    console.on("error", (error) => errors.push(error));
    const dom = new JSDOM(
      "<!doctype html><html><body><app-root></app-root></body></html>",
      {
        url: "http://angular.test/",
        runScripts: "outside-only",
        pretendToBeVisual: true,
        virtualConsole: console,
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
    const users = [{ id: 1, name: "Packed Angular" }];
    let writes = 0,
      reads = 0;
    window.fetch = async (url, init) => {
      if (String(url) !== "/api/users")
        throw Error("Unexpected Angular endpoint");
      if (init.method === "POST") {
        writes++;
        users.push({ id: 2, name: "Added Angular" });
      } else reads++;
      return new Response(
        JSON.stringify(init.method === "POST" ? users.at(-1) : users),
        { headers: { "content-type": "application/json" } },
      );
    };
    const wait = async (predicate) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (errors.length) throw errors[0];
        if (Date.now() > deadline)
          throw Error(
            "Angular DOM check timed out: " + window.document.body.textContent,
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      window.eval(bundle.outputFiles[0].text);
      await wait(() =>
        window.document.body.textContent.includes("Packed Angular"),
      );
      const add = [...window.document.querySelectorAll("button")].find(
        (button) => button.textContent.includes("Add user"),
      );
      await wait(() => !add.disabled);
      add.click();
      await wait(() =>
        window.document.body.textContent.includes("Added Angular"),
      );
      if (writes !== 1 || reads !== 2 || errors.length)
        throw (
          errors[0] ?? Error("Angular mutation did not explicitly refetch once")
        );
    } finally {
      window.close();
    }
    globalThis.console.log(
      `PASS Angular ${version} production AOT/strict templates/browser HTTP+mutation (${cwd})`,
    );
  }
}
