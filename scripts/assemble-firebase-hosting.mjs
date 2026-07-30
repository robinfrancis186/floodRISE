import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  FIREBASE_BUILD_METADATA_FILE,
  validateFirebaseBuildMetadata,
} from "./firebase-build-metadata.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const publishRoot = join(repositoryRoot, "dist", "firebase");
const stagingRoot = join(repositoryRoot, "dist", ".firebase-hosting-stage");
const applications = [
  {
    name: "Operations",
    prefix: "ops",
    source: join(repositoryRoot, "apps", "ops-web", "dist"),
  },
  {
    name: "Field",
    prefix: "field",
    source: join(repositoryRoot, "apps", "field-web", "dist"),
  },
];

const landingHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#ffffff" />
    <meta name="description" content="floodRISE emergency flood intelligence" />
    <link rel="stylesheet" href="/root.css" />
    <title>floodRISE</title>
  </head>
  <body>
    <main>
      <p class="eyebrow">Human-verified flood intelligence</p>
      <h1>floodRISE</h1>
      <p class="summary">Choose the workspace that matches your role.</p>
      <nav aria-label="floodRISE applications">
        <a class="primary" href="/ops/">
          <strong>Operations console</strong>
          <span>Live intelligence, review, routing, shelters and approvals</span>
        </a>
        <a href="/field/">
          <strong>Field application</strong>
          <span>Conditions, offline reporting, alerts and lower-risk routes</span>
        </a>
      </nav>
    </main>
  </body>
</html>
`;

const landingStyles = `:root {
  color: #132238;
  background: #f4f7fa;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; }
main { width: min(100%, 680px); background: #fff; border: 1px solid #d7e0e8; border-radius: 12px; padding: clamp(24px, 6vw, 48px); box-shadow: 0 18px 50px rgb(19 34 56 / 8%); }
.eyebrow { margin: 0 0 8px; color: #075a8c; font-size: 0.78rem; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
h1 { margin: 0; color: #092b4c; font-size: clamp(2.25rem, 9vw, 4.5rem); line-height: 0.95; letter-spacing: -0.055em; }
.summary { margin: 20px 0 28px; color: #4b5f73; font-size: 1.05rem; }
nav { display: grid; gap: 12px; }
a { min-height: 72px; display: grid; gap: 4px; align-content: center; padding: 16px 18px; color: #12324d; background: #f7fafc; border: 1px solid #cbd7e1; border-radius: 8px; text-decoration: none; }
a.primary { color: #fff; background: #075a8c; border-color: #075a8c; }
a:hover { border-color: #0b6fa8; }
a:focus-visible { outline: 3px solid #f5a623; outline-offset: 3px; }
strong { font-size: 1rem; }
span { color: inherit; font-size: 0.88rem; opacity: 0.82; }
@media (prefers-reduced-motion: no-preference) {
  a { transition: border-color 120ms ease, transform 120ms ease; }
  a:hover { transform: translateY(-1px); }
}
`;

async function assertDeployableDirectory(application) {
  let rootMetadata;
  try {
    rootMetadata = await lstat(application.source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `${application.name} build is missing at ${relative(repositoryRoot, application.source)}. Run pnpm build first.`,
      );
    }
    throw error;
  }

  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`${application.name} build root must be a real directory`);
  }

  const indexPath = join(application.source, "index.html");
  const indexMetadata = await lstat(indexPath);
  if (!indexMetadata.isFile() || indexMetadata.isSymbolicLink()) {
    throw new Error(`${application.name} build must contain a regular index.html`);
  }

  const expectedPrefix = `/${application.prefix}/`;
  const index = await readFile(indexPath, "utf8");
  if (!index.includes(expectedPrefix)) {
    throw new Error(
      `${application.name} build does not contain its required ${expectedPrefix} production prefix`,
    );
  }

  await assertTreeContainsNoSymlinks(application.source);

  const metadataPath = join(application.source, FIREBASE_BUILD_METADATA_FILE);
  const metadataFile = await lstat(metadataPath);
  if (!metadataFile.isFile() || metadataFile.isSymbolicLink()) {
    throw new Error(`${application.name} build metadata must be a regular file`);
  }
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`${application.name} build metadata is not valid JSON`, {
      cause: error,
    });
  }
  return validateFirebaseBuildMetadata(metadata, application.prefix);
}

async function assertTreeContainsNoSymlinks(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Firebase publish inputs cannot contain symbolic links: ${relative(repositoryRoot, path)}`);
    }
    if (entry.isDirectory()) await assertTreeContainsNoSymlinks(path);
  }
}

async function collectFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

function buildTarget(builds) {
  const [reference, ...siblings] = builds;
  for (const sibling of siblings) {
    for (const field of ["firebaseSdkVersion", "environment", "apiBase"]) {
      if (sibling[field] !== reference[field]) {
        throw new Error(`Firebase application builds disagree on ${field}.`);
      }
    }
    for (const field of ["projectId", "authDomain"]) {
      if (sibling.firebase[field] !== reference.firebase[field]) {
        throw new Error(`Firebase application builds disagree on firebase.${field}.`);
      }
    }
    for (const field of ["commit", "dirty", "treeSha256"]) {
      if (sibling.source[field] !== reference.source[field]) {
        throw new Error(`Firebase application builds disagree on source.${field}.`);
      }
    }
  }

  return {
    firebaseSdkVersion: reference.firebaseSdkVersion,
    environment: reference.environment,
    projectId: reference.firebase.projectId,
    authDomain: reference.firebase.authDomain,
    apiBase: reference.apiBase,
    applications: Object.fromEntries(
      builds.map((build) => [
        build.application,
        {
          appId: build.firebase.appId,
          publicConfigDigests: build.firebase.publicConfigDigests,
        },
      ]),
    ),
    source: reference.source,
  };
}

async function buildManifest(root, target) {
  const files = await collectFiles(root);
  const artifacts = [];
  for (const path of files) {
    if (path === "deployment-manifest.json") continue;
    const payload = await readFile(join(root, path));
    artifacts.push({
      path,
      bytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
  }
  return {
    format: 2,
    target,
    applications: Object.fromEntries(
      applications.map(({ prefix }) => [prefix, `/${prefix}/`]),
    ),
    artifacts,
  };
}

async function assemble() {
  const builds = await Promise.all(
    applications.map((application) => assertDeployableDirectory(application)),
  );
  const target = buildTarget(builds);

  await mkdir(dirname(stagingRoot), { recursive: true });
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  try {
    await Promise.all(
      applications.map(({ prefix, source }) =>
        cp(source, join(stagingRoot, prefix), {
          recursive: true,
          force: false,
          errorOnExist: true,
        }),
      ),
    );
    await writeFile(join(stagingRoot, "index.html"), landingHtml, "utf8");
    await writeFile(join(stagingRoot, "root.css"), landingStyles, "utf8");

    const manifest = await buildManifest(stagingRoot, target);
    await writeFile(
      join(stagingRoot, "deployment-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await rm(publishRoot, { recursive: true, force: true });
    await rename(stagingRoot, publishRoot);
    process.stdout.write(
      `Firebase Hosting artifact assembled at ${relative(repositoryRoot, publishRoot)} (${manifest.artifacts.length} files)\n`,
    );
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

await assemble();
