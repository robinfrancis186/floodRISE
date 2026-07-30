import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { before, test } from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const publishRoot = join(repositoryRoot, "dist", "firebase");
const assemblyScript = join(repositoryRoot, "scripts", "assemble-firebase-hosting.mjs");
const firebaseConfig = JSON.parse(
  await readFile(join(repositoryRoot, "firebase.json"), "utf8"),
);

async function assemble() {
  await execFileAsync(process.execPath, [assemblyScript], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      // Assembly is deliberately independent from Firebase credentials and
      // must not discover a project through a developer's local environment.
      FIREBASE_CONFIG: "",
      GCLOUD_PROJECT: "",
      GOOGLE_APPLICATION_CREDENTIALS: "",
    },
  });
}

async function filesUnder(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  for (const path of await filesUnder(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function headerValuesFor(source) {
  const rule = firebaseConfig.hosting.headers.find((candidate) => candidate.source === source);
  assert(rule, `missing Hosting header rule for ${source}`);
  return Object.fromEntries(rule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
}

before(async () => {
  await assemble();
});

test("Firebase Hosting publishes the assembled artifact and routes API before both SPAs", () => {
  const hosting = firebaseConfig.hosting;
  assert.equal(hosting.public, "dist/firebase");
  assert.deepEqual(hosting.ignore, [
    "firebase.json",
    "**/.*",
    "**/node_modules/**",
  ]);

  const [api, operations, field, landing] = hosting.rewrites;
  assert.deepEqual(api, {
    source: "/api/**",
    run: {
      serviceId: "floodrise-api",
      region: "asia-south1",
      pinTag: true,
    },
  });
  assert.deepEqual(operations, {
    source: "/ops/**",
    destination: "/ops/index.html",
  });
  assert.deepEqual(field, {
    source: "/field/**",
    destination: "/field/index.html",
  });
  assert.deepEqual(landing, {
    source: "**",
    destination: "/index.html",
  });
  assert(
    hosting.rewrites.findIndex(({ run }) => Boolean(run))
      < hosting.rewrites.findIndex(({ destination }) => Boolean(destination)),
    "the Cloud Run API rewrite must precede every static SPA fallback",
  );
});

test("Firebase Hosting opens Operations from the root and reserves a conflict-free local port", () => {
  assert.deepEqual(firebaseConfig.hosting.redirects, [
    { source: "/", destination: "/ops/", type: 302 },
  ]);
  assert.deepEqual(firebaseConfig.emulators.hosting, {
    host: "127.0.0.1",
    port: 5500,
  });
});

test("Hosting applies browser security, API privacy, service-worker, and immutable asset headers", () => {
  const security = headerValuesFor("**");
  assert.match(security["content-security-policy"], /default-src 'self'/);
  assert.match(security["content-security-policy"], /frame-ancestors 'none'/);
  assert.match(
    security["content-security-policy"],
    /connect-src 'self' https:\/\/tile\.openstreetmap\.org https:\/\/\*\.openstreetmap\.org/,
  );
  for (const endpoint of [
    "https://content-firebaseappcheck.googleapis.com",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
  ]) {
    assert.match(security["content-security-policy"], new RegExp(endpoint.replaceAll(".", "\\.")));
  }
  assert.match(
    security["content-security-policy"],
    /script-src 'self' https:\/\/apis\.google\.com https:\/\/www\.google\.com\/recaptcha\/ https:\/\/www\.gstatic\.com\/recaptcha\//,
  );
  assert.match(
    security["content-security-policy"],
    /frame-src https:\/\/apis\.google\.com https:\/\/__FLOODRISE_AUTH_DOMAIN__ https:\/\/www\.google\.com\/recaptcha\/ https:\/\/www\.gstatic\.com\/recaptcha\//,
  );
  assert.doesNotMatch(
    security["content-security-policy"],
    /frame-src[^;]*https:\/\/\*[^;]*(?:firebaseapp|web\.app)/,
  );
  assert.doesNotMatch(security["content-security-policy"], /https:\/\/\*\.googleapis\.com/);
  assert.doesNotMatch(security["content-security-policy"], /https:\/\/\*\.google\.com/);
  const cspSourceTokens = security["content-security-policy"]
    .split(/[;\s]+/u)
    .filter(Boolean);
  for (const unusedBrowserEndpoint of [
    "https://firebaseappcheck.googleapis.com",
    "https://firebaseinstallations.googleapis.com",
    "https://fcmregistrations.googleapis.com",
    "https://fcm.googleapis.com",
  ]) {
    assert.ok(
      !cspSourceTokens.includes(unusedBrowserEndpoint),
      `${unusedBrowserEndpoint} is not used by the reviewed browser SDK path`,
    );
  }
  assert.equal(security["cross-origin-opener-policy"], "same-origin");
  assert.equal(security["cross-origin-resource-policy"], "same-origin");
  assert.equal(security["cache-control"], "no-cache, no-store, must-revalidate");
  assert.equal(
    security["permissions-policy"],
    "camera=(self), geolocation=(self), microphone=(), payment=(), usb=()",
  );
  assert.equal(security["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(security["x-content-type-options"], "nosniff");
  assert.equal(security["x-frame-options"], "DENY");

  assert.equal(headerValuesFor("/api/**")["cache-control"], "private, no-store");
  assert.equal(
    headerValuesFor("/field/@(sw.js|registerSW.js|manifest.webmanifest)")["service-worker-allowed"],
    "/field/",
  );
  assert.match(
    headerValuesFor("/field/@(sw.js|registerSW.js|manifest.webmanifest)")["cache-control"],
    /no-store/,
  );
  for (const source of ["/ops/assets/**", "/field/assets/**"]) {
    assert.equal(
      headerValuesFor(source)["cache-control"],
      "public, max-age=31536000, immutable",
    );
  }
});

test("assembly copies both production builds without changing their URL prefixes", async () => {
  for (const prefix of ["ops", "field"]) {
    const sourceRoot = join(repositoryRoot, "apps", `${prefix}-web`, "dist");
    const targetRoot = join(publishRoot, prefix);
    assert.deepEqual(await filesUnder(targetRoot), await filesUnder(sourceRoot));

    const index = await readFile(join(targetRoot, "index.html"), "utf8");
    const urls = [...index.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)].map((match) => match[1]);
    assert(urls.length > 0, `${prefix} index must reference generated assets`);
    assert(
      urls.every((url) => url.startsWith(`/${prefix}/`)),
      `${prefix} references must remain confined to /${prefix}/`,
    );
  }

  const fieldManifest = JSON.parse(
    await readFile(join(publishRoot, "field", "manifest.webmanifest"), "utf8"),
  );
  assert.equal(fieldManifest.start_url, "/field/");
  assert.equal(fieldManifest.scope, "/field/");
  assert(fieldManifest.icons.every(({ src }) => src.startsWith("/field/")));

  const registration = await readFile(join(publishRoot, "field", "registerSW.js"), "utf8");
  assert.match(registration, /register\(['"]\/field\/sw\.js['"]/);
  assert.match(registration, /scope:\s*['"]\/field\/['"]/);
  assert.doesNotMatch(registration, /scope:\s*['"]\/['"]/);

  const serviceWorker = await readFile(join(publishRoot, "field", "sw.js"), "utf8");
  assert.match(serviceWorker, /\/field\/index\.html/);
  assert.doesNotMatch(serviceWorker, /\/ops\//);
});

test("assembly emits a static, accessible landing fallback and an integrity manifest", async () => {
  const landing = await readFile(join(publishRoot, "index.html"), "utf8");
  assert.match(landing, /<main>/);
  assert.match(landing, /aria-label="floodRISE applications"/);
  assert.match(landing, /href="\/ops\/"/);
  assert.match(landing, /href="\/field\/"/);
  assert.doesNotMatch(landing, /<script/i);
  await stat(join(publishRoot, "root.css"));

  const manifest = JSON.parse(
    await readFile(join(publishRoot, "deployment-manifest.json"), "utf8"),
  );
  assert.equal(manifest.format, 2);
  assert.equal(manifest.target.firebaseSdkVersion, "12.16.0");
  assert(["local", "demo", "live"].includes(manifest.target.environment));
  assert.equal(manifest.target.apiBase, "/api/v1");
  assert.match(manifest.target.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof manifest.target.source.dirty, "boolean");
  assert.match(manifest.target.source.treeSha256, /^[0-9a-f]{64}$/);
  for (const application of ["ops", "field"]) {
    const buildMetadata = JSON.parse(
      await readFile(
        join(publishRoot, application, "floodrise-build-metadata.json"),
        "utf8",
      ),
    );
    assert.equal(buildMetadata.application, application);
    assert.equal(
      buildMetadata.firebaseSdkVersion,
      manifest.target.firebaseSdkVersion,
    );
    assert.equal(buildMetadata.environment, manifest.target.environment);
    assert.equal(buildMetadata.apiBase, manifest.target.apiBase);
    assert.deepEqual(buildMetadata.source, manifest.target.source);
    assert.equal(
      buildMetadata.firebase.appId,
      manifest.target.applications[application].appId,
    );
    assert.deepEqual(
      buildMetadata.firebase.publicConfigDigests,
      manifest.target.applications[application].publicConfigDigests,
    );
    if (buildMetadata.environment === "local") {
      assert.equal(buildMetadata.firebase.publicConfigDigests, null);
    } else {
      for (const digest of Object.values(
        buildMetadata.firebase.publicConfigDigests,
      )) {
        assert.match(digest, /^[0-9a-f]{64}$/);
      }
    }
  }
  assert.deepEqual(manifest.applications, {
    ops: "/ops/",
    field: "/field/",
  });
  assert.equal(
    manifest.artifacts.length,
    (await filesUnder(publishRoot)).length - 1,
    "manifest must cover every published artifact except itself",
  );

  const manifestPaths = new Set();
  for (const artifact of manifest.artifacts) {
    assert(!manifestPaths.has(artifact.path), `duplicate manifest path: ${artifact.path}`);
    manifestPaths.add(artifact.path);
    assert(!artifact.path.startsWith(".."));
    const payload = await readFile(join(publishRoot, artifact.path));
    assert.equal(payload.byteLength, artifact.bytes);
    assert.equal(
      createHash("sha256").update(payload).digest("hex"),
      artifact.sha256,
    );
  }
});

test("assembled deploy tree contains regular files and no symbolic links", async () => {
  async function inspect(current) {
    for (const entry of await readdir(current)) {
      const path = join(current, entry);
      const metadata = await lstat(path);
      assert(!metadata.isSymbolicLink(), `${relative(publishRoot, path)} must not be a symbolic link`);
      if (metadata.isDirectory()) await inspect(path);
    }
  }
  await inspect(publishRoot);
});

test("assembly is byte-for-byte deterministic for unchanged application builds", async () => {
  const first = await treeDigest(publishRoot);
  await assemble();
  assert.equal(await treeDigest(publishRoot), first);
});

test("Firebase tooling is pinned and credential-free checks are exposed through package scripts", async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["firebase:assemble"],
    "node scripts/assemble-firebase-hosting.mjs",
  );
  assert.match(packageJson.scripts["firebase:test"], /firebase-hosting-conformance\.test\.mjs/);
  assert.match(
    packageJson.scripts["firebase:emulate"],
    /pnpm --allow-build=protobufjs dlx firebase-tools@\d+\.\d+\.\d+ emulators:start --only hosting/,
  );
  assert.match(
    packageJson.scripts["firebase:deploy:hosting"],
    /^node scripts\/deploy-firebase-hosting\.mjs$/,
  );
});
