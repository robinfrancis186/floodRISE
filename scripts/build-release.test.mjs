import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("protected releases reject missing or unsafe public configuration before building", () => {
  for (const authority of ["", "http://identity.example.in", "https://user:secret@identity.example.in"]) {
    const result = spawnSync(process.execPath, ["scripts/build-release.mjs"], {
      encoding: "utf8",
      env: { ...process.env, VITE_DEMO_MODE: "false", VITE_OIDC_AUTHORITY: authority,
        VITE_OIDC_CLIENT_ID: "public-client", VITE_API_ROOT: "https://api.example.in/api/v1" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Protected release requires VITE_OIDC_AUTHORITY|must be an HTTPS URL without credentials/);
    assert.doesNotMatch(result.stdout, /Release assembled/);
  }
});
