import { spawnSync } from "node:child_process";
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run npm run check using npm >=11.21.1.");
for (const task of [
  "lint",
  "typecheck",
  "test",
  "check:consumers",
  "audit:all",
  "format:check",
]) {
  const result = spawnSync(process.execPath, [npm, "run", task], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
