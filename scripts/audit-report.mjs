import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const npm = process.env.npm_execpath;
if (!npm) throw Error("Run npm run audit:report.");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const run = (args) =>
  spawnSync(process.execPath, [npm, ...args], { encoding: "utf8" });
const capture = (production) => {
  const args = [
    "audit",
    "--json",
    "--registry=https://registry.npmjs.org/",
    ...(production ? ["--omit=dev"] : []),
  ];
  const result = run(args);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw Error("npm audit did not return a valid report");
  }
  if (report.error || !report.metadata?.vulnerabilities)
    throw Error(
      "npm audit could not complete; no zero-findings claim can be made.",
    );
  return {
    command: "npm " + args.join(" "),
    scope: production
      ? "repository production dependency selection (optional frameworks installed as development dependencies may be excluded)"
      : "repository lockfile including development dependencies and installed peers",
    exitCode: result.status,
    metadata: report.metadata,
    advisories: Object.entries(report.vulnerabilities ?? {}).map(
      ([name, value]) => ({
        name,
        severity: value.severity,
        isDirect: value.isDirect,
        via: value.via,
        fixAvailable: value.fixAvailable,
      }),
    ),
  };
};
const report = {
  package: pkg.name,
  version: pkg.version,
  generatedAtUtc: new Date().toISOString(),
  node: process.version,
  npm: run(["--version"]).stdout.trim(),
  lockfileSha256: createHash("sha256")
    .update(readFileSync("package-lock.json"))
    .digest("hex"),
  limitation:
    "Known-advisory dependency inventory only. This is not a comprehensive security audit, penetration test or proof of application/transport security. Other consumers and peer selections have independent dependency graphs.",
  checks: [capture(false), capture(true)],
};
mkdirSync("reports", { recursive: true });
writeFileSync(
  "reports/dependency-audit.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "Wrote versioned dependency inventory: reports/dependency-audit.json",
);
if (report.checks.some((check) => check.metadata.vulnerabilities.total > 0))
  process.exitCode = 1;
