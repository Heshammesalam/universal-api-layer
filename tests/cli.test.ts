import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const cli = resolve("dist/cli/index.js");
for (const framework of ["react", "vue"])
  for (const language of ["javascript", "typescript"])
    it(`${framework} ${language} scaffolds and preserves files`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "ual-cli-"));
      const run = (extra: string[] = []) =>
        spawnSync(
          process.execPath,
          [
            cli,
            "init",
            "--framework",
            framework,
            "--language",
            language,
            ...extra,
          ],
          { cwd, encoding: "utf8" },
        );
      expect(run().status).toBe(0);
      const file = join(
        cwd,
        `src/ApiExample.${framework === "vue" ? "vue" : language === "typescript" ? "tsx" : "jsx"}`,
      );
      const text = await readFile(file, "utf8");
      expect(text).toContain(`universal-api-layer/${framework}`);
      expect(text.includes('lang="ts"')).toBe(
        framework === "vue" && language === "typescript",
      );
      await writeFile(file, "keep");
      expect(run().status).toBe(1);
      expect(await readFile(file, "utf8")).toBe("keep");
      expect(run(["--force"]).status).toBe(0);
    });
it("fails actionably when detection is ambiguous", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ual-cli-"));
  const result = spawnSync(process.execPath, [cli, "init"], {
    cwd,
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--framework");
});
it("detects framework and source language", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ual-cli-"));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ dependencies: { react: "*" } }),
  );
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src/main.jsx"), "");
  expect(spawnSync(process.execPath, [cli, "init"], { cwd }).status).toBe(0);
});

it.each(["javascript", "typescript"])(
  "detects Vue SFC %s",
  async (language) => {
    const cwd = await mkdtemp(join(tmpdir(), "ual-cli-"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { vue: "*" } }),
    );
    await mkdir(join(cwd, "src"));
    await writeFile(
      join(cwd, "src/App.vue"),
      language === "typescript"
        ? '<script setup lang="ts">const x = 1;</script>'
        : "<script setup>const x = 1;</script>",
    );
    const result = spawnSync(process.execPath, [cli, "init"], {
      cwd,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      await readFile(
        join(cwd, `src/api.${language === "typescript" ? "ts" : "js"}`),
        "utf8",
      ),
    ).toContain("createApiClient");
  },
);
it("requires a language flag for conflicting language configs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ual-cli-"));
  await writeFile(join(cwd, "tsconfig.json"), "{}");
  await writeFile(join(cwd, "jsconfig.json"), "{}");
  const result = spawnSync(
    process.execPath,
    [cli, "init", "--framework", "react"],
    { cwd, encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--language");
});

it("detects source language in a project without src", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ual-cli-"));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ dependencies: { react: "*" } }),
  );
  await writeFile(
    join(cwd, "App.jsx"),
    "export default function App(){return null}",
  );
  await mkdir(join(cwd, "node_modules"));
  await writeFile(join(cwd, "node_modules/types.ts"), "");
  const result = spawnSync(process.execPath, [cli, "init"], {
    cwd,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(join(cwd, "src/api.js"), "utf8")).toContain(
    "createApiClient",
  );
});
it("validates explicit flags before requesting missing choices", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ual-cli-"));
  const result = spawnSync(
    process.execPath,
    [cli, "init", "--framework", "angular"],
    { cwd, encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--framework react|vue");
});
