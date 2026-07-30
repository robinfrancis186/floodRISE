import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import { after, before, test } from "node:test";
import { runInNewContext } from "node:vm";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const appRoots = {
  ops: join(repositoryRoot, "apps/ops-web/dist"),
  field: join(repositoryRoot, "apps/field-web/dist"),
};

function contentType(pathname) {
  return {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
  }[extname(pathname)] ?? "application/octet-stream";
}

async function resolveCloudFrontRequest(pathname) {
  if (pathname === "/ops" || pathname === "/field") {
    return { redirect: `${pathname}/` };
  }
  if (pathname === "/") return { filePath: join(appRoots.ops, "index.html") };

  for (const [prefix, appRoot] of Object.entries(appRoots)) {
    if (!pathname.startsWith(`/${prefix}/`)) continue;
    const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
    if (!lastSegment.includes(".")) return { filePath: join(appRoot, "index.html") };

    const artifactPath = normalize(join(appRoot, pathname.slice(prefix.length + 2)));
    if (relative(appRoot, artifactPath).startsWith("..")) return undefined;
    return { filePath: artifactPath };
  }

  return undefined;
}

let server;
let origin;

before(async () => {
  for (const appRoot of Object.values(appRoots)) {
    await stat(join(appRoot, "index.html"));
  }

  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const result = await resolveCloudFrontRequest(url.pathname);
      if (!result) {
        response.writeHead(404).end("Not found");
        return;
      }
      if (result.redirect) {
        response.writeHead(308, {
          location: result.redirect,
          "cache-control": "public, max-age=300",
        }).end();
        return;
      }
      const body = await readFile(result.filePath);
      response.writeHead(200, { "content-type": contentType(result.filePath) }).end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
});

function documentUrls(html) {
  return [...html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)].map((match) => match[1]);
}

async function builtStylesheet(pathname) {
  const response = await fetch(`${origin}${pathname}`);
  assert.equal(response.status, 200, `${pathname} should resolve before inspecting its styles`);
  const stylesheetUrls = documentUrls(await response.text()).filter((url) => url.endsWith(".css"));
  assert(stylesheetUrls.length > 0, `${pathname} must reference a production stylesheet`);
  return (
    await Promise.all(stylesheetUrls.map(async (url) => {
      const stylesheet = await fetch(`${origin}${url}`);
      assert.equal(stylesheet.status, 200, `${url} must be available in the production layout`);
      return stylesheet.text();
    }))
  ).join("\n");
}

function pngDimensions(payload) {
  assert.equal(
    payload.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    "install icon must be a PNG",
  );
  assert.equal(payload.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: payload.readUInt32BE(16),
    height: payload.readUInt32BE(20),
  };
}

async function expectDocumentAndAssets(pathname, prefix) {
  const response = await fetch(`${origin}${pathname}`);
  assert.equal(response.status, 200, `${pathname} should resolve through the CloudFront layout`);
  const html = await response.text();
  assert.match(html, /<div id="root"><\/div>/);

  const urls = documentUrls(html);
  assert(urls.length > 0, `${pathname} must reference generated assets`);
  for (const url of urls) {
    assert(
      url.startsWith(`/${prefix}/`),
      `${pathname} emitted ${url}; every static reference must remain inside /${prefix}/`,
    );
    assert.equal((await fetch(`${origin}${url}`)).status, 200, `${url} must exist in the publish layout`);
  }
  return html;
}

test("Operations artifacts and nested routes are rooted at /ops/", async () => {
  await expectDocumentAndAssets("/", "ops");
  await expectDocumentAndAssets("/ops/", "ops");
  await expectDocumentAndAssets("/ops/signals", "ops");
});

test("bare application prefixes redirect to their trailing-slash canonical URLs", async () => {
  for (const prefix of ["ops", "field"]) {
    const response = await fetch(`${origin}/${prefix}`, { redirect: "manual" });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), `/${prefix}/`);
  }
});

test("the checked-in CloudFront function implements the tested canonicalization and SPA rewrites", async () => {
  const edgeModule = await readFile(
    join(repositoryRoot, "infra/terraform/modules/edge/main.tf"),
    "utf8",
  );
  const functionSource = edgeModule.match(/code\s*=\s*<<-JAVASCRIPT\n([\s\S]*?)\n\s*JAVASCRIPT/)?.[1];
  assert(functionSource, "CloudFront function source must be present in the edge module");

  const sandbox = {};
  runInNewContext(`${functionSource}\nthis.cloudFrontHandler = handler;`, sandbox);
  const handler = sandbox.cloudFrontHandler;
  assert.equal(typeof handler, "function");

  for (const prefix of ["/ops", "/field"]) {
    const response = handler({ request: { uri: prefix } });
    assert.equal(response.statusCode, 308);
    assert.equal(response.headers.location.value, `${prefix}/`);
  }

  for (const [uri, rewritten] of [
    ["/", "/ops/index.html"],
    ["/ops/signals", "/ops/index.html"],
    ["/field/report", "/field/index.html"],
  ]) {
    const request = { uri };
    assert.equal(handler({ request }).uri, rewritten);
  }

  const apiRequest = { uri: "/api/v1/incidents" };
  assert.equal(handler({ request: apiRequest }), apiRequest);
});

test("Field artifacts and nested routes are rooted at /field/", async () => {
  const html = await expectDocumentAndAssets("/field/", "field");
  await expectDocumentAndAssets("/field/report", "field");
  assert.match(html, /href="\/field\/manifest\.webmanifest"/);
  assert.match(
    html,
    /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/,
  );
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="apple-mobile-web-app-status-bar-style" content="default"/);
  assert.match(html, /name="apple-mobile-web-app-title" content="floodRISE"/);
  assert.match(
    html,
    /rel="apple-touch-icon" sizes="180x180" href="\/field\/icons\/floodrise-apple-touch-180\.png"/,
  );

  const manifestResponse = await fetch(`${origin}/field/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.start_url, "/field/");
  assert.equal(manifest.scope, "/field/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "any");
  assert(manifest.icons.every(({ src }) => src.startsWith("/field/")));

  const expectedIcons = new Map([
    ["/field/icons/floodrise-192.png", { sizes: "192x192", purpose: "any", pixels: 192 }],
    ["/field/icons/floodrise-512.png", { sizes: "512x512", purpose: "any", pixels: 512 }],
    ["/field/icons/floodrise-maskable-512.png", { sizes: "512x512", purpose: "maskable", pixels: 512 }],
  ]);
  assert.equal(manifest.icons.length, expectedIcons.size);
  for (const icon of manifest.icons) {
    const expected = expectedIcons.get(icon.src);
    assert(expected, `unexpected Field install icon: ${icon.src}`);
    assert.equal(icon.type, "image/png");
    assert.equal(icon.sizes, expected.sizes);
    assert.equal(icon.purpose, expected.purpose);
    const response = await fetch(`${origin}${icon.src}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(pngDimensions(Buffer.from(await response.arrayBuffer())), {
      width: expected.pixels,
      height: expected.pixels,
    });
  }

  const appleIcon = Buffer.from(
    await (await fetch(`${origin}/field/icons/floodrise-apple-touch-180.png`)).arrayBuffer(),
  );
  assert.deepEqual(pngDimensions(appleIcon), { width: 180, height: 180 });
});

test("Field service worker registration and navigation fallback cannot claim Operations", async () => {
  const registration = await (await fetch(`${origin}/field/registerSW.js`)).text();
  assert.match(registration, /register\(['"]\/field\/sw\.js['"]/);
  assert.match(registration, /scope:\s*['"]\/field\/['"]/);
  assert.doesNotMatch(registration, /scope:\s*['"]\/['"]/);

  const serviceWorker = await (await fetch(`${origin}/field/sw.js`)).text();
  assert.match(serviceWorker, /\/field\/index\.html/);
  for (const installAsset of [
    "icons/floodrise-192.png",
    "icons/floodrise-512.png",
    "icons/floodrise-maskable-512.png",
    "icons/floodrise-apple-touch-180.png",
  ]) {
    assert.match(serviceWorker, new RegExp(`url:["']${installAsset.replaceAll("/", "\\/")}["']`));
  }
  assert.doesNotMatch(serviceWorker, /\/ops\//);
  assert.doesNotMatch(serviceWorker, /createHandlerBoundToURL\(["']\/index\.html["']\)/);
});

test("production Field and Operations styles include the complete map system before app overrides", async () => {
  for (const [prefix, localOverride] of [
    ["field", ".field-app .fr-map-legend"],
    ["ops", ".app-frame .fr-map-legend"],
  ]) {
    const stylesheet = await builtStylesheet(`/${prefix}/`);

    for (const selector of [
      ".fr-map-canvas-shell",
      ".fr-map-legend",
      ".fr-map-attribution",
      ".fr-map-sr-only",
      ".maplibregl-map",
      ".maplibregl-canvas",
      ".maplibregl-ctrl-group",
    ]) {
      assert(
        stylesheet.includes(selector),
        `/${prefix}/ production CSS must include ${selector}`,
      );
    }

    const screenReaderRule = stylesheet.match(/\.fr-map-sr-only\{([^}]*)\}/)?.[1];
    assert(screenReaderRule, `/${prefix}/ must emit the map screen-reader-only rule`);
    assert.match(screenReaderRule, /position:absolute!important/);
    assert.match(screenReaderRule, /width:1px!important/);
    assert.match(screenReaderRule, /height:1px!important/);
    assert.match(screenReaderRule, /overflow:hidden!important/);
    assert.match(screenReaderRule, /clip:rect\(0,0,0,0\)!important/);

    const baseRuleIndex = stylesheet.indexOf(".fr-map-legend");
    const localOverrideIndex = stylesheet.indexOf(localOverride);
    assert(
      localOverrideIndex > baseRuleIndex,
      `/${prefix}/ local map overrides must follow the shared map stylesheet`,
    );
  }
});
