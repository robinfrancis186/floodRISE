import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFirebasePublicConfigDigests,
  normalizeFirebaseApiBase,
  normalizeFirebaseAppId,
  normalizeFirebaseAuthDomain,
  normalizeFirebaseProjectId,
  FIREBASE_WEB_SDK_VERSION,
  readFirebaseSourceState,
} from "./firebase-build-metadata.mjs";

export const FIREBASE_TOOLS_VERSION = "15.24.0";

const environments = ["demo", "live"];
const applications = ["ops", "field"];
const deploymentManifestName = "deployment-manifest.json";
const authDomainPlaceholder = "https://__FLOODRISE_AUTH_DOMAIN__";
const valueOptions = new Map([
  ["--environment", "environment"],
  ["--project", "project"],
  ["--confirm-target", "confirmTarget"],
]);
const booleanOptions = new Map([
  ["--execute", "execute"],
  ["--validate-only", "validateOnly"],
]);
const placeholderPattern = /(replace-with|placeholder|example|your[-_])/i;
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(scriptPath));

function parseArguments(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;

    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);

    if (booleanOptions.has(option)) {
      if (inlineValue !== undefined) {
        throw new Error(`${option} does not accept a value.`);
      }
      const key = booleanOptions.get(option);
      if (parsed[key] !== undefined) throw new Error(`${option} may be supplied only once.`);
      parsed[key] = true;
      continue;
    }

    if (valueOptions.has(option)) {
      const key = valueOptions.get(option);
      if (parsed[key] !== undefined) throw new Error(`${option} may be supplied only once.`);
      const value = inlineValue ?? args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
      parsed[key] = value;
      continue;
    }

    throw new Error(`Unknown option ${argument}.`);
  }

  return parsed;
}

export function validateProjectMap(projectMap) {
  if (!projectMap || typeof projectMap !== "object" || Array.isArray(projectMap)) {
    throw new Error("The reviewed Firebase project mapping must be a JSON object.");
  }
  if (
    !projectMap.projects
    || typeof projectMap.projects !== "object"
    || Array.isArray(projectMap.projects)
  ) {
    throw new Error("The reviewed Firebase project mapping must define projects.demo and projects.live.");
  }

  const validated = {};
  for (const environment of environments) {
    const projectId = projectMap.projects[environment];
    if (typeof projectId !== "string" || !projectId) {
      throw new Error(`The reviewed Firebase project mapping is missing projects.${environment}.`);
    }
    if (placeholderPattern.test(projectId)) {
      throw new Error(`projects.${environment} is still a placeholder.`);
    }
    try {
      validated[environment] = normalizeFirebaseProjectId(projectId);
    } catch {
      throw new Error(`projects.${environment} must be a valid Firebase project ID.`);
    }
  }

  if (validated.demo === validated.live) {
    throw new Error("Demo and live must use different Firebase projects.");
  }

  return validated;
}

export function validateTargetMap(targetMap, projects) {
  if (
    !targetMap
    || typeof targetMap !== "object"
    || Array.isArray(targetMap)
    || targetMap.format !== 1
    || !targetMap.targets
    || typeof targetMap.targets !== "object"
    || Array.isArray(targetMap.targets)
  ) {
    throw new Error("The reviewed Firebase target map must use format 1 with demo and live targets.");
  }

  const validated = {};
  for (const environment of environments) {
    const raw = targetMap.targets[environment];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`The reviewed Firebase target map is missing targets.${environment}.`);
    }
    if (placeholderPattern.test(JSON.stringify(raw))) {
      throw new Error(`targets.${environment} still contains a placeholder.`);
    }

    const projectId = normalizeFirebaseProjectId(raw.projectId);
    if (projectId !== projects[environment]) {
      throw new Error(
        `targets.${environment}.projectId does not match the reviewed Firebase alias.`,
      );
    }
    const targetApplications = {};
    for (const application of applications) {
      const rawApplication = raw.applications?.[application];
      targetApplications[application] = {
        appId: normalizeFirebaseAppId(rawApplication?.appId),
        publicConfigDigests: createFirebasePublicConfigDigests({
          apiKey: rawApplication?.apiKey,
          appCheckSiteKey: rawApplication?.appCheckSiteKey,
          authProviderId: rawApplication?.authProviderId,
        }),
      };
    }
    validated[environment] = {
      environment,
      projectId,
      authDomain: normalizeFirebaseAuthDomain(raw.authDomain),
      apiBase: normalizeFirebaseApiBase(raw.apiBase),
      applications: targetApplications,
    };
    if (
      new Set(
        applications.map((application) => targetApplications[application].appId),
      ).size !== applications.length
    ) {
      throw new Error(
        `targets.${environment} must use different Field and Operations web app IDs.`,
      );
    }
  }

  if (validated.demo.authDomain === validated.live.authDomain) {
    throw new Error("Demo and live must use different reviewed Firebase auth domains.");
  }
  const demoAppIds = new Set(
    applications.map((application) => validated.demo.applications[application].appId),
  );
  if (
    applications.some(
      (application) => demoAppIds.has(validated.live.applications[application].appId),
    )
  ) {
    throw new Error("Demo and live must use different Firebase web app IDs.");
  }

  return validated;
}

export function validateDeploymentRequest({ args, projectMap, targetMap }) {
  const options = parseArguments(args);
  const projects = validateProjectMap(projectMap);
  const targets = validateTargetMap(targetMap, projects);

  if (!options.environment) throw new Error("--environment is required.");
  if (!environments.includes(options.environment)) {
    throw new Error("--environment must be exactly demo or live.");
  }
  if (!options.project) throw new Error("--project is required.");
  if (!options.confirmTarget) throw new Error("--confirm-target is required.");
  if (Boolean(options.execute) === Boolean(options.validateOnly)) {
    throw new Error("Choose exactly one of --execute or --validate-only.");
  }

  const otherEnvironment = environments.find(
    (environment) =>
      environment !== options.environment
      && (options.project === environment || options.project === projects[environment]),
  );
  if (otherEnvironment) {
    throw new Error(`The requested project belongs to the ${otherEnvironment} environment.`);
  }

  const projectId = projects[options.environment];
  if (options.project !== options.environment && options.project !== projectId) {
    throw new Error(
      `The requested project does not match the reviewed ${options.environment} project.`,
    );
  }

  const expectedConfirmation = `${projectId}:${options.environment}`;
  if (options.confirmTarget !== expectedConfirmation) {
    throw new Error(`--confirm-target must exactly equal ${expectedConfirmation}.`);
  }

  return {
    environment: options.environment,
    projectId,
    execute: Boolean(options.execute),
    target: targets[options.environment],
  };
}

function sameSourceState(left, right) {
  return (
    left?.commit === right?.commit
    && left?.dirty === right?.dirty
    && left?.treeSha256 === right?.treeSha256
  );
}

function assertDeploymentTarget(manifest, deployment, sourceState) {
  if (!manifest || typeof manifest !== "object" || manifest.format !== 2) {
    throw new Error("Firebase artifact manifest format is missing or unsupported.");
  }
  const target = manifest.target;
  const expected = deployment.target;
  if (target?.firebaseSdkVersion !== FIREBASE_WEB_SDK_VERSION) {
    throw new Error("Firebase artifact SDK version does not match the reviewed CSP contract.");
  }
  for (const field of ["environment", "projectId", "authDomain", "apiBase"]) {
    if (target?.[field] !== expected[field]) {
      throw new Error(`Firebase artifact target.${field} does not match the confirmed target.`);
    }
  }
  for (const application of applications) {
    const actualApplication = target?.applications?.[application];
    const expectedApplication = expected.applications[application];
    if (
      actualApplication?.appId
      !== expectedApplication.appId
    ) {
      throw new Error(
        `Firebase artifact ${application} app ID does not match the confirmed target.`,
      );
    }
    for (const [field, label] of [
      ["apiKeySha256", "API key"],
      ["appCheckSiteKeySha256", "App Check site key"],
      ["authProviderIdSha256", "Auth provider ID"],
    ]) {
      if (
        actualApplication?.publicConfigDigests?.[field]
        !== expectedApplication.publicConfigDigests[field]
      ) {
        throw new Error(
          `Firebase artifact ${application} ${label} digest does not match the confirmed target.`,
        );
      }
    }
  }
  if (!sameSourceState(target?.source, sourceState)) {
    throw new Error("Firebase artifact was not built from the current source state.");
  }
  if (deployment.execute && sourceState.dirty) {
    throw new Error(
      "Firebase execution requires a clean committed source tree; rebuild after committing.",
    );
  }
}

async function filesUnder(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Firebase publish artifact cannot contain a symbolic link: ${relative(root, path)}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...await filesUnder(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    } else {
      throw new Error(
        `Firebase publish artifact contains an unsupported entry: ${relative(root, path)}`,
      );
    }
  }
  return files.sort();
}

export async function validateDeploymentArtifact({
  publishRoot,
  manifest,
  deployment,
  sourceState,
}) {
  assertDeploymentTarget(manifest, deployment, sourceState);
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error("Firebase artifact manifest must contain an artifacts array.");
  }

  const recordedPaths = new Set();
  for (const artifact of manifest.artifacts) {
    if (
      !artifact
      || typeof artifact.path !== "string"
      || !artifact.path
      || artifact.path.startsWith("/")
      || artifact.path.includes("\\")
      || artifact.path.split("/").some((part) => part === "" || part === "." || part === "..")
      || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 0
      || !/^[0-9a-f]{64}$/u.test(artifact.sha256)
    ) {
      throw new Error("Firebase artifact manifest contains an invalid file receipt.");
    }
    if (recordedPaths.has(artifact.path)) {
      throw new Error(`Firebase artifact manifest repeats ${artifact.path}.`);
    }
    recordedPaths.add(artifact.path);

    const path = join(publishRoot, artifact.path);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Firebase artifact is not a regular file: ${artifact.path}`);
    }
    const payload = await readFile(path);
    if (payload.byteLength !== artifact.bytes) {
      throw new Error(`Firebase artifact size changed after assembly: ${artifact.path}`);
    }
    const digest = createHash("sha256").update(payload).digest("hex");
    if (digest !== artifact.sha256) {
      throw new Error(`Firebase artifact hash changed after assembly: ${artifact.path}`);
    }
  }

  const actualPaths = (await filesUnder(publishRoot)).filter(
    (path) => path !== deploymentManifestName,
  );
  if (
    actualPaths.length !== recordedPaths.size
    || actualPaths.some((path) => !recordedPaths.has(path))
  ) {
    throw new Error("Firebase publish tree and artifact manifest do not contain the same files.");
  }

  return {
    artifactCount: recordedPaths.size,
    source: sourceState,
  };
}

export async function revalidateDeploymentBoundary({
  publishRoot,
  manifestPath,
  deployment,
  sourceRoot = repositoryRoot,
  sourceStateReader = readFirebaseSourceState,
}) {
  const sourceState = sourceStateReader(sourceRoot);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return validateDeploymentArtifact({
    publishRoot,
    manifest,
    deployment,
    sourceState,
  });
}

function cspDirectives(policy) {
  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...values] = directive.split(/\s+/u);
        return [name, values];
      }),
  );
}

function sameDirectiveSources(actual, expected) {
  return (
    actual.length === expected.length
    && expected.every((source) => actual.includes(source))
  );
}

export function renderFirebaseConfig(template, target) {
  const rendered = structuredClone(template);
  const globalHeaders = rendered.hosting?.headers?.find((entry) => entry.source === "**");
  const cspHeader = globalHeaders?.headers?.find(
    (header) => header.key.toLowerCase() === "content-security-policy",
  );
  if (!cspHeader || typeof cspHeader.value !== "string") {
    throw new Error("Firebase config is missing the global Content-Security-Policy.");
  }
  const frameOptions = globalHeaders.headers.find(
    (header) => header.key.toLowerCase() === "x-frame-options",
  );
  if (frameOptions?.value !== "DENY") {
    throw new Error("Firebase config must retain X-Frame-Options DENY.");
  }

  const occurrences = cspHeader.value.split(authDomainPlaceholder).length - 1;
  if (occurrences !== 1) {
    throw new Error("Firebase CSP must contain exactly one auth-domain placeholder.");
  }
  const authOrigin = `https://${normalizeFirebaseAuthDomain(target.authDomain)}`;
  cspHeader.value = cspHeader.value.replace(authDomainPlaceholder, authOrigin);

  const directives = cspDirectives(cspHeader.value);
  const frameSources = directives.get("frame-src") ?? [];
  const scriptSources = directives.get("script-src") ?? [];
  const connectSources = directives.get("connect-src") ?? [];
  if (
    JSON.stringify(directives.get("frame-ancestors"))
    !== JSON.stringify(["'none'"])
  ) {
    throw new Error("Firebase CSP must deny every framing ancestor.");
  }
  const expectedConnections = [
    "'self'",
    "https://tile.openstreetmap.org",
    "https://*.openstreetmap.org",
    "https://content-firebaseappcheck.googleapis.com",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://www.google.com/recaptcha/",
  ];
  if (!sameDirectiveSources(connectSources, expectedConnections)) {
    throw new Error("Firebase CSP connect-src must contain only reviewed runtime origins.");
  }
  const expectedScripts = [
    "'self'",
    "https://apis.google.com",
    "https://www.google.com/recaptcha/",
    "https://www.gstatic.com/recaptcha/",
  ];
  if (!sameDirectiveSources(scriptSources, expectedScripts)) {
    throw new Error("Firebase CSP script-src must contain only reviewed runtime origins.");
  }
  const expectedFrames = [
    "https://apis.google.com",
    authOrigin,
    "https://www.google.com/recaptcha/",
    "https://www.gstatic.com/recaptcha/",
  ];
  if (
    !sameDirectiveSources(frameSources, expectedFrames)
    || frameSources.some((origin) => origin.includes("*"))
  ) {
    throw new Error("Firebase CSP frame-src must contain only reviewed exact origins.");
  }
  return rendered;
}

export function buildFirebaseDeployCommand({ projectId, firebaseConfigPath }) {
  return {
    command: "pnpm",
    args: [
      "--allow-build=protobufjs",
      "dlx",
      `firebase-tools@${FIREBASE_TOOLS_VERSION}`,
      "deploy",
      "--only",
      "hosting",
      "--project",
      projectId,
      "--config",
      firebaseConfigPath,
    ],
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

async function main() {
  const projectMapPath = join(repositoryRoot, ".firebaserc");
  const targetMapPath = join(repositoryRoot, ".firebase-targets.json");
  let projectMap;
  let targetMap;
  try {
    projectMap = JSON.parse(await readFile(projectMapPath, "utf8"));
  } catch (error) {
    throw new Error(
      "Refusing Firebase deployment: create and review .firebaserc from "
        + ".firebaserc.example before selecting a target.",
      { cause: error },
    );
  }
  try {
    targetMap = JSON.parse(await readFile(targetMapPath, "utf8"));
  } catch (error) {
    throw new Error(
      "Refusing Firebase deployment: create and review .firebase-targets.json from "
        + ".firebase-targets.example.json before selecting a target.",
      { cause: error },
    );
  }

  const deployment = validateDeploymentRequest({
    args: process.argv.slice(2),
    projectMap,
    targetMap,
  });

  const sourceState = readFirebaseSourceState(repositoryRoot);
  run(process.execPath, [join(repositoryRoot, "scripts", "assemble-firebase-hosting.mjs")]);
  const publishRoot = join(repositoryRoot, "dist", "firebase");
  const manifestPath = join(publishRoot, deploymentManifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const artifact = await validateDeploymentArtifact({
    publishRoot,
    manifest,
    deployment,
    sourceState,
  });
  const firebaseTemplate = JSON.parse(
    await readFile(join(repositoryRoot, "firebase.json"), "utf8"),
  );
  const renderedConfig = renderFirebaseConfig(firebaseTemplate, deployment.target);
  const firebaseConfigPath = resolve(repositoryRoot, "firebase.deploy.generated.json");
  await writeFile(
    firebaseConfigPath,
    `${JSON.stringify(renderedConfig, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  if (!deployment.execute) {
    process.stdout.write(
      `${JSON.stringify({
        validated: true,
        environment: deployment.environment,
        projectId: deployment.projectId,
        authDomain: deployment.target.authDomain,
        applications: deployment.target.applications,
        source: artifact.source,
        artifactCount: artifact.artifactCount,
        deployed: false,
      })}\n`,
    );
    return;
  }

  // Close the validation-to-deploy window as far as the local guard can: an
  // editor, build, or concurrent process may have changed either the source or
  // assembled publish tree after the first receipt check.
  await revalidateDeploymentBoundary({
    publishRoot,
    manifestPath,
    deployment,
  });

  const deploy = buildFirebaseDeployCommand({
    projectId: deployment.projectId,
    firebaseConfigPath,
  });
  run(deploy.command, deploy.args);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`Firebase deployment guard: ${error.message}\n`);
    process.exitCode = 1;
  });
}
