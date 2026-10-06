import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.env.VITE_DEMO_MODE === "false") {
  for (const key of ["VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID", "VITE_API_ROOT"]) {
    if (!process.env[key]?.trim()) throw new Error(`Protected release requires ${key}.`);
  }
  for (const key of ["VITE_OIDC_AUTHORITY", "VITE_API_ROOT"]) {
    const url = new URL(process.env[key]);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${key} must be an HTTPS URL without credentials.`);
  }
}

for (const app of ["ops-web", "field-web"]) {
  const result = spawnSync("pnpm", ["--filter", `@floodrise/${app}`, "build"], {
    stdio: "inherit",
    env: { ...process.env, VITE_FIELD_BASE_PATH: "/field/", VITE_API_BASE_URL: process.env.VITE_API_ROOT ?? process.env.VITE_API_BASE_URL ?? "/api/v1" },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const output = resolve("dist");
rmSync(output, { recursive: true, force: true });
mkdirSync(output);
cpSync("apps/ops-web/dist", output, { recursive: true });
cpSync("apps/field-web/dist", resolve(output, "field"), { recursive: true });
const fieldAssets = resolve(output, "field/assets");
if (!readdirSync(fieldAssets).filter((file) => file.endsWith(".css"))
  .some((file) => readFileSync(resolve(fieldAssets, file), "utf8").includes(".fr-map-sr-only"))) {
  throw new Error("Field release is missing the shared map stylesheet.");
}
const manifest = JSON.parse(readFileSync(resolve(output, "field/manifest.webmanifest"), "utf8"));
if (manifest.scope !== "/field/" || manifest.start_url !== "/field/") throw new Error("Field PWA scope is incorrect.");
console.log("Release assembled: operations at / and field PWA at /field/.");
