import { verifyAngularConsumers } from "./angular-consumer.mjs";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { verifyBrowserConsumer } from "./browser-consumer.mjs";
const root = process.cwd();
const npm = process.env.npm_execpath;
function run(args, cwd = root) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10e6,
  });
  if (r.status !== 0)
    throw new Error(`${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
if (!npm) throw new Error("Run this check through npm run check:consumers.");
const npmVersion = run([npm, "--version"]).trim();
const [npmMajor, npmMinor, npmPatch] = npmVersion.split(".").map(Number);
if (
  npmMajor < 11 ||
  (npmMajor === 11 && (npmMinor < 21 || (npmMinor === 21 && npmPatch < 1)))
)
  throw new Error(
    "Use npm >=11.21.1; older npm versions have an optional-peer resolution bug.",
  );
const minimum = process.env.UAL_COMPATIBILITY === "minimum";
const reactVersion = minimum ? "18.0.0" : "^19.0.0";
const vueVersion = minimum ? "3.3.0" : "^3.5.0";
const queryVersion = minimum ? "5.0.0" : "^5.0.0";
run([npm, "run", "build"]);
const pack = JSON.parse(
  run([
    npm,
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    tmpdir(),
  ]),
);
const tar = join(tmpdir(), pack[0].filename);
for (const framework of ["core", "react", "vue"])
  for (const language of ["javascript", "typescript"]) {
    const cwd = mkdtempSync(join(tmpdir(), `ual-${framework}-${language}-`));
    const deps = { "universal-api-layer": `file:${tar}` };
    if (framework === "react")
      Object.assign(deps, {
        react: reactVersion,
        "react-dom": reactVersion,
        "@tanstack/react-query": queryVersion,
      });
    if (framework === "vue")
      Object.assign(deps, {
        vue: vueVersion,
        "@tanstack/vue-query": queryVersion,
      });
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: deps,
        devDependencies:
          framework === "core"
            ? language === "typescript"
              ? { typescript: "^5.9.0", "@types/node": "^22.0.0" }
              : {}
            : {
                vite: "^8.3.5",
                ...(framework === "vue"
                  ? { "@vitejs/plugin-vue": "^6.0.10", "vue-tsc": "^3.0.0" }
                  : {}),
                ...(language === "typescript"
                  ? {
                      typescript: "^5.9.0",
                      ...(framework === "react"
                        ? {
                            "@types/react": minimum ? "^18.0.0" : "^19.0.0",
                            "@types/react-dom": minimum ? "^18.0.0" : "^19.0.0",
                          }
                        : {}),
                    }
                  : {}),
              },
      }),
    );
    run([npm, "install", "--no-audit", "--no-fund"], cwd);
    const req = createRequire(join(cwd, "package.json"));
    for (const missing of framework === "core"
      ? [
          "react",
          "react-dom",
          "vue",
          "@tanstack/react-query",
          "@tanstack/vue-query",
          "@angular/core",
          "rxjs",
        ]
      : framework === "react"
        ? ["vue", "@tanstack/vue-query", "@angular/core", "rxjs"]
        : [
            "react",
            "react-dom",
            "@tanstack/react-query",
            "@angular/core",
            "rxjs",
          ]) {
      let found = false;
      try {
        req.resolve(missing);
        found = true;
      } catch {
        /* The unused adapter must not resolve. */
      }
      if (found) throw new Error(`${missing} unexpectedly installed in ${cwd}`);
    }
    run(
      [
        "--input-type=module",
        "-e",
        `import {createApiClient} from 'universal-api-layer'; const data=await createApiClient({fetch:async()=>new Response('ok')}).request('/');if(data!=='ok')throw Error('core failed');`,
      ],
      cwd,
    );
    run(
      [
        "--input-type=module",
        "-e",
        `import { ApiError, createApiClient, runMutation } from 'universal-api-layer'; const c = createApiClient({fetch:async()=>new Response(null,{status:204})}); if(await c.request('/')!==null) throw Error('empty response contract'); try { await runMutation(c,{url:'/',select:()=>{throw Error('callback')}},{}); throw Error('expected failure'); } catch(e) { if(!(e instanceof ApiError) || e.code!=='callback') throw e; }`,
      ],
      cwd,
    );
    run(
      [
        "--input-type=module",
        "-e",
        `import {createApiClient,DEFAULT_TIMEOUT_MS} from 'universal-api-layer';let refreshes=0;const c=createApiClient({session:{userId:'a',token:'OLD_PRIVATE_TOKEN'},refreshToken:async()=>{refreshes++;return 'FRESH_PRIVATE_TOKEN'},fetch:async(_url,init)=>new Headers(init.headers).get('authorization')==='Bearer FRESH_PRIVATE_TOKEN'?new Response(JSON.stringify({value:'validated'}),{headers:{'content-type':'application/json'}}):new Response(null,{status:401})});const value=await c.request('/',{schema:data=>{if(!data||typeof data!=='object'||!('value' in data))throw Error('invalid');return data.value}});if(value!=='validated'||refreshes!==1||DEFAULT_TIMEOUT_MS!==15000)throw Error('managed core features failed');if(JSON.stringify(c.queryKey([], '/')).includes('PRIVATE_TOKEN'))throw Error('token leaked');c.logout();if(c.getSessionSnapshot().userId!==null)throw Error('logout failed');`,
      ],
      cwd,
    );
    run(
      [
        "--input-type=module",
        "-e",
        `import {createApiClient} from 'universal-api-layer';const c=createApiClient({fetch:async()=>new Response('data: first\\n\\ndata: second\\n\\n',{headers:{'content-type':'text/event-stream'}})});const result=[];for await(const e of c.stream('/',{format:'sse'}))result.push(e.data);if(result.join(',')!=='first,second')throw Error('packed streaming failed');`,
      ],
      cwd,
    );
    run(
      [
        "--input-type=module",
        "-e",
        `import {verifyPackedSocket} from ${JSON.stringify(pathToFileURL(join(root, "scripts/socket-consumer.mjs")).href)};await verifyPackedSocket(import.meta.resolve('universal-api-layer/websocket'),import.meta.resolve('universal-api-layer'));`,
      ],
      cwd,
    );
    if (framework === "core" && language === "typescript") {
      writeFileSync(
        join(cwd, "consumer.ts"),
        `import {createApiClient} from 'universal-api-layer'; const value = await createApiClient().request<{id:number}>('/');
// @ts-expect-error Empty HTTP responses may be null.
const unsafe: {id:number} = value;
const safe: {id:number}|null = value; void unsafe; void safe;
const client=createApiClient({session:{userId:'a',token:'token'},refreshToken:async()=> 'new'});
const parsed=await client.request('/',{schema:(data:unknown)=>({id:String(data)})});
const selected:{id:string}|null=parsed;void selected;
// @ts-expect-error Session snapshots must not expose tokens.
client.getSessionSnapshot().token;
const {createSocketClient}=await import('universal-api-layer/websocket');
const socket=createSocketClient({url:'wss://socket.test',schema:(value:unknown)=>String(value)});
socket.onMessage(value=>{const typed:string=value;void typed;});socket.dispose();
const textStream:AsyncGenerator<string,void,unknown>=client.stream('/');void textStream;
const events=client.stream('/',{format:'sse'});for await(const event of events){const data:string=event.data;void data;break;}
client.setSession({userId:'b',token:'b'});client.logout();`,
      );
      writeFileSync(
        join(cwd, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            skipLibCheck: false,
            lib: ["ES2022"],
            types: ["node"],
          },
          include: ["consumer.ts"],
        }),
      );
      run([join(cwd, "node_modules/typescript/bin/tsc"), "--noEmit"], cwd);
    }
    if (framework !== "core") {
      run(
        [
          join(cwd, "node_modules/universal-api-layer/dist/cli/index.js"),
          "init",
          "--framework",
          framework,
          "--language",
          language,
        ],
        cwd,
      );
      const ts = language === "typescript";
      const ext =
        framework === "react" ? (ts ? "tsx" : "jsx") : ts ? "ts" : "js";
      writeFileSync(
        join(cwd, "index.html"),
        `<div id="app"></div><script type="module" src="/src/main.${ext}"></script>`,
      );
      writeFileSync(
        join(cwd, `src/main.${ext}`),
        framework === "react"
          ? `import React from 'react';import {createRoot} from 'react-dom/client';import {ApiProvider} from 'universal-api-layer/react';import {client} from './api';import Example from './ApiExample';Object.assign(globalThis,{__apiClient:client});createRoot(document.getElementById('app')${ts ? "!" : ""}).render(<ApiProvider client={client}><Example /></ApiProvider>);`
          : `import {createApp} from 'vue';import {createApiPlugin} from 'universal-api-layer/vue';import {client} from './api';import Example from './ApiExample.vue';Object.assign(globalThis,{__apiClient:client});createApp(Example).use(createApiPlugin({client})).mount('#app');`,
      );
      writeFileSync(
        join(cwd, "vite.config.mjs"),
        framework === "vue"
          ? `import vue from '@vitejs/plugin-vue';export default {plugins:[vue()]};`
          : `export default {esbuild:{jsx:'automatic'}};`,
      );
      if (ts) {
        const chat =
          framework === "vue" ? "StreamingChat.vue" : "StreamingChat.tsx";
        copyFileSync(
          join(root, "examples", framework, "src", chat),
          join(cwd, "src", chat),
        );
        const socketChat =
          framework === "vue" ? "WebSocketChat.vue" : "WebSocketChat.tsx";
        copyFileSync(
          join(root, "examples", framework, "src", socketChat),
          join(cwd, "src", socketChat),
        );
        writeFileSync(
          join(cwd, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              jsx: "react-jsx",
              strict: true,
              skipLibCheck: false,
              lib: ["ES2022", "DOM"],
              types: [],
            },
            include: ["src"],
          }),
        );
        const tool =
          framework === "vue" ? "vue-tsc/bin/vue-tsc.js" : "typescript/bin/tsc";
        run([join(cwd, "node_modules", tool), "--noEmit"], cwd);
      }
      run([join(cwd, "node_modules/vite/bin/vite.js"), "build"], cwd);
      await verifyBrowserConsumer(cwd);
    }
    console.log(`PASS ${framework} ${language} (${cwd})`);
  }

await verifyAngularConsumers(tar, root, npm, minimum);
