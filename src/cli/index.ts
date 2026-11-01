#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
export function templates(
  framework: string,
  language: string,
): Record<string, string> {
  const ts = language === "typescript";
  const ext = ts ? "ts" : "js";
  const setup = `import { createApiClient } from 'universal-api-layer';\nexport const client = createApiClient({ baseUrl: '/api' });\n`;
  const type = ts
    ? "<{ data: { id: number; name: string }[] }, { id: number; name: string }[]>"
    : "";
  if (framework === "react")
    return {
      [`src/api.${ext}`]: setup,
      [`src/ApiExample.${ts ? "tsx" : "jsx"}`]: `import { useApiQuery, useApiMutation } from 'universal-api-layer/react';\nexport default function ApiExample() {\n  const users = useApiQuery${type}({ key: ['users'], url: '/users', select: response => response?.data ?? [] });\n  const create = useApiMutation({ url: '/users', invalidateKeys: [['users']] });\n  return <section><button onClick={() => create.mutate({ name: 'Bahaa' })}>Add user</button>{users.isPending ? <p>Loading...</p> : users.error ? <p>{users.error.message}</p> : <pre>{JSON.stringify(users.data)}</pre>}{create.error && <pre>{JSON.stringify(create.error.fieldErrors)}</pre>}</section>;\n}\n`,
    };
  return {
    [`src/api.${ext}`]: setup,
    "src/ApiExample.vue": `<script setup${ts ? ' lang="ts"' : ""}>\nimport { useApiQuery, useApiMutation } from 'universal-api-layer/vue';\nconst { data, isPending, error } = useApiQuery${type}({ key: ['users'], url: '/users', select: response => response?.data ?? [] });\nconst { mutate, error: mutationError } = useApiMutation({ url: '/users', invalidateKeys: [['users']] });\n</script>\n<template><section><button @click="mutate({ name: 'Bahaa' })">Add user</button><p v-if="isPending">Loading...</p><p v-else-if="error">{{ error.message }}</p><pre v-else>{{ data }}</pre><pre v-if="mutationError">{{ mutationError.fieldErrors }}</pre></section></template>\n`,
  };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "universal-api-layer init [--framework react|vue] [--language javascript|typescript] [--force]",
    );
    return;
  }
  if (args.shift() !== "init")
    throw new Error(
      "Use: universal-api-layer init --framework react|vue --language javascript|typescript",
    );
  const flags: Record<string, string> = {};
  let force = false;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (
      !["--framework", "--language"].includes(arg) ||
      !args[0] ||
      args[0].startsWith("--")
    )
      throw new Error(`Invalid option ${arg}. Use --help.`);
    flags[arg.slice(2)] = args.shift()!;
  }
  if (flags.framework && !["react", "vue"].includes(flags.framework))
    throw new Error("Expected --framework react|vue.");
  if (flags.language && !["javascript", "typescript"].includes(flags.language))
    throw new Error("Expected --language javascript|typescript.");
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(await readFile("package.json", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const frameworks = ["react", "vue"].filter((name) => deps[name]);
  const exists = async (name: string) =>
    access(name).then(
      () => true,
      () => false,
    );
  let framework =
    flags.framework ?? (frameworks.length === 1 ? frameworks[0] : undefined);
  const hasTsConfig = await exists("tsconfig.json");
  const hasJsConfig = await exists("jsconfig.json");
  let language =
    flags.language ??
    (hasTsConfig !== hasJsConfig
      ? hasTsConfig
        ? "typescript"
        : "javascript"
      : undefined);
  // Conflicting configs require an explicit choice; otherwise inspect sources.
  if (!language && !(hasTsConfig && hasJsConfig)) {
    const { readdir } = await import("node:fs/promises");
    const ignored = new Set([
      "node_modules",
      "dist",
      "build",
      "coverage",
      ".git",
      ".next",
      ".nuxt",
      ".output",
      ".artifacts",
      "tests",
      "test",
    ]);
    async function sourceFiles(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const children = await Promise.all(
        entries
          .filter(
            (entry) => !ignored.has(entry.name) && !entry.name.startsWith("."),
          )
          .map(async (entry) => {
            const name = resolve(directory, entry.name);
            if (entry.isDirectory()) return sourceFiles(name);
            return entry.isFile() &&
              /\.(?:[cm]?[jt]sx?|vue)$/.test(entry.name) &&
              !/\.(?:config|test|spec|d)\.[cm]?[jt]sx?$/.test(entry.name)
              ? [name]
              : [];
          }),
      );
      return children.flat();
    }
    const files = await sourceFiles((await exists("src")) ? "src" : ".");
    let ts = files.some((f) => /\.(ts|tsx|mts|cts)$/.test(f));
    let js = files.some((f) => /\.(js|jsx|mjs|cjs)$/.test(f));
    for (const name of files.filter((f) => f.endsWith(".vue"))) {
      const source = await readFile(name, "utf8");
      if (/<script\b[^>]*\blang\s*=\s*['"]ts['"]/i.test(source)) ts = true;
      else js = true;
    }
    if (ts !== js) language = ts ? "typescript" : "javascript";
  }
  async function choose(label: string, choices: string[]) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        `Cannot detect ${label}. Pass --${label} ${choices.join("|")} in non-interactive mode.`,
      );
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return (await input.question(`${label} (${choices.join("/")}): `)).trim();
    } finally {
      input.close();
    }
  }
  framework ??= await choose("framework", ["react", "vue"]);
  language ??= await choose("language", ["javascript", "typescript"]);
  if (
    !["react", "vue"].includes(framework) ||
    !["javascript", "typescript"].includes(language)
  )
    throw new Error(
      "Expected --framework react|vue and --language javascript|typescript.",
    );
  const files = templates(framework, language);
  if (!force)
    for (const name of Object.keys(files))
      if (await exists(name))
        throw new Error(
          `Refusing to overwrite ${name}. Use --force to replace generated files.`,
        );
  for (const [name, content] of Object.entries(files)) {
    await mkdir(resolve(name, ".."), { recursive: true });
    await writeFile(name, content, { flag: force ? "w" : "wx" });
  }
  console.log(
    `Created API setup and example.\nInstall: npm install universal-api-layer ${framework === "react" ? "react@^19 react-dom@^19 @tanstack/react-query@^5" : "vue@^3.5 @tanstack/vue-query@^5"}`,
  );
  console.log(
    "Requires Node >=22.13 and npm >=11.21.1; install the listed optional peers explicitly.",
  );
  console.log(
    framework === "react"
      ? "Import { client } from './api'; import { ApiProvider } from 'universal-api-layer/react'; wrap <App /> with <ApiProvider client={client}>. ApiProvider installs QueryClientProvider; pass queryClient to reuse an existing instance."
      : "Import { client } from './api'; import { createApiPlugin } from 'universal-api-layer/vue'; call app.use(createApiPlugin({ client })) before app.mount().",
  );
  if (deps.next || deps.nuxt)
    console.log(
      "Next.js/Nuxt detected: only standalone API/example files were generated; register them manually. Next.js requires a client provider boundary; Nuxt requires a client plugin and a per-request client for SSR. Configure these manually.",
    );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
