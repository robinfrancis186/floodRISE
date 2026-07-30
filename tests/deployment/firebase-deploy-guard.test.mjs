import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFirebasePublicConfigDigests,
} from "../../scripts/firebase-build-metadata.mjs";
import {
  FIREBASE_TOOLS_VERSION,
  buildFirebaseDeployCommand,
  revalidateDeploymentBoundary,
  renderFirebaseConfig,
  validateDeploymentArtifact,
  validateDeploymentRequest,
  validateProjectMap,
  validateTargetMap,
} from "../../scripts/deploy-firebase-hosting.mjs";

function publicConfiguration(seed, provider) {
  return {
    apiKey: `AIza${seed.repeat(35)}`,
    appCheckSiteKey: `6L${seed.repeat(38)}`,
    authProviderId: `oidc.${provider}`,
  };
}

const demoOpsPublicConfig = publicConfiguration("A", "demo-ops");
const demoFieldPublicConfig = publicConfiguration("B", "demo-field");
const liveOpsPublicConfig = publicConfiguration("C", "live-ops");
const liveFieldPublicConfig = publicConfiguration("D", "live-field");
const projectMap = {
  projects: {
    demo: "floodrise-demo-5305",
    live: "floodrise-production-5305",
  },
};
const targetMap = {
  format: 1,
  targets: {
    demo: {
      projectId: "floodrise-demo-5305",
      authDomain: "floodrise-demo-5305.firebaseapp.com",
      apiBase: "/api/v1",
      applications: {
        ops: {
          appId: "1:123456789012:web:aaaaaaaaaaaaaaaaaaaaaa",
          ...demoOpsPublicConfig,
        },
        field: {
          appId: "1:123456789012:web:bbbbbbbbbbbbbbbbbbbbbb",
          ...demoFieldPublicConfig,
        },
      },
    },
    live: {
      projectId: "floodrise-production-5305",
      authDomain: "auth.floodrise.gov.in",
      apiBase: "/api/v1",
      applications: {
        ops: {
          appId: "1:987654321098:web:cccccccccccccccccccccc",
          ...liveOpsPublicConfig,
        },
        field: {
          appId: "1:987654321098:web:dddddddddddddddddddddd",
          ...liveFieldPublicConfig,
        },
      },
    },
  },
};

function expectedTarget(environment) {
  const raw = targetMap.targets[environment];
  return {
    environment,
    projectId: raw.projectId,
    authDomain: raw.authDomain,
    apiBase: raw.apiBase,
    applications: Object.fromEntries(
      Object.entries(raw.applications).map(([application, configuration]) => [
        application,
        {
          appId: configuration.appId,
          publicConfigDigests: createFirebasePublicConfigDigests(configuration),
        },
      ]),
    ),
  };
}

const sourceState = {
  commit: "a".repeat(40),
  dirty: false,
  treeSha256: "b".repeat(64),
};

function deploymentRequest(args) {
  return validateDeploymentRequest({ args, projectMap, targetMap });
}

test("deployment guard accepts only an explicitly confirmed mapped target", () => {
  const byAlias = deploymentRequest(
    [
      "--environment",
      "demo",
      "--project",
      "demo",
      "--confirm-target",
      "floodrise-demo-5305:demo",
      "--validate-only",
    ],
  );
  assert.deepEqual(byAlias, {
    environment: "demo",
    projectId: "floodrise-demo-5305",
    execute: false,
    target: expectedTarget("demo"),
  });
  for (const exactValue of Object.values(demoOpsPublicConfig)) {
    assert.doesNotMatch(
      JSON.stringify(byAlias),
      new RegExp(exactValue.replaceAll(".", "\\.")),
    );
  }

  const byExactProject = deploymentRequest(
    [
      "--environment=live",
      "--project=floodrise-production-5305",
      "--confirm-target=floodrise-production-5305:live",
      "--execute",
    ],
  );
  assert.deepEqual(byExactProject, {
    environment: "live",
    projectId: "floodrise-production-5305",
    execute: true,
    target: expectedTarget("live"),
  });
});

test("deployment guard rejects implicit, unrelated, and cross-environment targets", () => {
  const cases = [
    {
      args: [
        "--project",
        "demo",
        "--confirm-target",
        "floodrise-demo-5305:demo",
        "--validate-only",
      ],
      message: /--environment is required/,
    },
    {
      args: [
        "--environment",
        "demo",
        "--confirm-target",
        "floodrise-demo-5305:demo",
        "--validate-only",
      ],
      message: /--project is required/,
    },
    {
      args: [
        "--environment",
        "demo",
        "--project",
        "live",
        "--confirm-target",
        "floodrise-demo-5305:demo",
        "--validate-only",
      ],
      message: /belongs to the live environment/,
    },
    {
      args: [
        "--environment",
        "demo",
        "--project",
        "floodrise-production-5305",
        "--confirm-target",
        "floodrise-demo-5305:demo",
        "--validate-only",
      ],
      message: /belongs to the live environment/,
    },
    {
      args: [
        "--environment",
        "demo",
        "--project",
        "unrelated-project",
        "--confirm-target",
        "unrelated-project:demo",
        "--validate-only",
      ],
      message: /does not match the reviewed demo project/,
    },
    {
      args: [
        "--environment",
        "demo",
        "--project",
        "demo",
        "--confirm-target",
        "floodrise-demo-5305:live",
        "--validate-only",
      ],
      message: /--confirm-target must exactly equal floodrise-demo-5305:demo/,
    },
    {
      args: [
        "--environment",
        "demo",
        "--project",
        "demo",
        "--confirm-target",
        "floodrise-demo-5305:demo",
      ],
      message: /Choose exactly one of --execute or --validate-only/,
    },
    {
      args: [
        "--environment",
        "demo",
        "--project",
        "demo",
        "--confirm-target",
        "floodrise-demo-5305:demo",
        "--execute",
        "--validate-only",
      ],
      message: /Choose exactly one of --execute or --validate-only/,
    },
    {
      args: [
        "--environment",
        "demo",
        "--project",
        "demo",
        "--confirm-target",
        "floodrise-demo-5305:demo",
        "--validate-only",
        "--only",
        "functions",
      ],
      message: /Unknown option --only/,
    },
  ];

  for (const item of cases) {
    assert.throws(
      () => validateDeploymentRequest({ args: item.args, projectMap, targetMap }),
      item.message,
    );
  }
});

test("deployment guard rejects placeholder, malformed, and shared project mappings", async () => {
  const [exampleProjectMap, exampleTargetMap] = await Promise.all([
    readFile(new URL("../../.firebaserc.example", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../.firebase-targets.example.json", import.meta.url), "utf8").then(
      JSON.parse,
    ),
  ]);
  assert.throws(
    () => validateProjectMap(exampleProjectMap),
    /placeholder/,
  );
  assert.throws(
    () =>
      validateTargetMap(exampleTargetMap, {
        demo: "floodrise-demo-5305",
        live: "floodrise-production-5305",
      }),
    /placeholder/,
  );
  assert.throws(
    () =>
      validateProjectMap({
        projects: {
          demo: "floodrise-demo-5305",
          live: "floodrise-demo-5305",
        },
      }),
    /must use different Firebase projects/,
  );
  assert.throws(
    () =>
      validateProjectMap({
        projects: {
          demo: "not valid",
          live: "floodrise-production-5305",
        },
      }),
    /valid Firebase project ID/,
  );
});

test("reviewed target map binds project, auth domain, API base, and per-app public config", () => {
  const projects = validateProjectMap(projectMap);
  assert.deepEqual(validateTargetMap(targetMap, projects), {
    demo: expectedTarget("demo"),
    live: expectedTarget("live"),
  });

  assert.throws(
    () =>
      validateTargetMap(
        {
          ...targetMap,
          targets: {
            ...targetMap.targets,
            live: {
              ...targetMap.targets.live,
              authDomain: "*.firebaseapp.com",
            },
          },
        },
        projects,
      ),
    /exact lowercase HTTPS hostname/,
  );
  assert.throws(
    () =>
      validateTargetMap(
        {
          ...targetMap,
          targets: {
            ...targetMap.targets,
            live: {
              ...targetMap.targets.live,
              apiBase: "https://api.floodrise.invalid/api/v1",
            },
          },
        },
        projects,
      ),
    /same-origin absolute path/,
  );
  assert.throws(
    () =>
      validateTargetMap(
        {
          ...targetMap,
          targets: {
            ...targetMap.targets,
            live: {
              ...targetMap.targets.live,
              applications: {
                ...targetMap.targets.live.applications,
                ops: {
                  ...targetMap.targets.live.applications.ops,
                  apiKey: "not-a-firebase-api-key",
                },
              },
            },
          },
        },
        projects,
      ),
    /exact AIza-formatted public key/,
  );
  assert.throws(
    () =>
      validateTargetMap(
        {
          ...targetMap,
          targets: {
            ...targetMap.targets,
            live: {
              ...targetMap.targets.live,
              applications: {
                ...targetMap.targets.live.applications,
                field: {
                  ...targetMap.targets.live.applications.field,
                  authProviderId: "saml.not-allowed",
                },
              },
            },
          },
        },
        projects,
      ),
    /exact oidc\.\* provider ID/,
  );
  assert.throws(
    () =>
      validateTargetMap(
        {
          ...targetMap,
          targets: {
            ...targetMap.targets,
            demo: {
              ...targetMap.targets.demo,
              applications: {
                ops: targetMap.targets.demo.applications.ops,
                field: targetMap.targets.demo.applications.ops,
              },
            },
          },
        },
        projects,
      ),
    /different Field and Operations web app IDs/,
  );
});

test("artifact validation rejects config/source drift, hash drift, and extra files", async () => {
  const root = await mkdtemp(join(tmpdir(), "floodrise-firebase-artifact-"));
  const path = join(root, "index.html");
  const payload = Buffer.from("<!doctype html><title>bound artifact</title>");
  await writeFile(path, payload);
  const deployment = deploymentRequest([
    "--environment",
    "demo",
    "--project",
    "demo",
    "--confirm-target",
    "floodrise-demo-5305:demo",
    "--validate-only",
  ]);
  const manifest = {
    format: 2,
    target: {
      firebaseSdkVersion: "12.16.0",
      ...deployment.target,
      source: sourceState,
    },
    artifacts: [
      {
        path: "index.html",
        bytes: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    ],
  };

  try {
    assert.deepEqual(
      await validateDeploymentArtifact({
        publishRoot: root,
        manifest,
        deployment,
        sourceState,
      }),
      { artifactCount: 1, source: sourceState },
    );

    for (const [field, value, label] of [
      [
        "apiKey",
        `${demoOpsPublicConfig.apiKey.slice(0, -1)}Z`,
        /ops API key digest does not match/,
      ],
      [
        "appCheckSiteKey",
        `${demoOpsPublicConfig.appCheckSiteKey.slice(0, -1)}Z`,
        /ops App Check site key digest does not match/,
      ],
      [
        "authProviderId",
        `${demoOpsPublicConfig.authProviderId}-other`,
        /ops Auth provider ID digest does not match/,
      ],
    ]) {
      const changedTargetMap = structuredClone(targetMap);
      changedTargetMap.targets.demo.applications.ops[field] = value;
      const changedDeployment = validateDeploymentRequest({
        args: [
          "--environment",
          "demo",
          "--project",
          "demo",
          "--confirm-target",
          "floodrise-demo-5305:demo",
          "--validate-only",
        ],
        projectMap,
        targetMap: changedTargetMap,
      });
      await assert.rejects(
        validateDeploymentArtifact({
          publishRoot: root,
          manifest,
          deployment: changedDeployment,
          sourceState,
        }),
        label,
      );
    }

    await assert.rejects(
      validateDeploymentArtifact({
        publishRoot: root,
        manifest: {
          ...manifest,
          target: {
            ...manifest.target,
            applications: {
              ...manifest.target.applications,
              field: { appId: "1:123456789012:web:eeeeeeeeeeeeeeeeeeeeee" },
            },
          },
        },
        deployment,
        sourceState,
      }),
      /field app ID does not match/,
    );
    for (const [field, label] of [
      ["apiKeySha256", /ops API key digest does not match/],
      ["appCheckSiteKeySha256", /ops App Check site key digest does not match/],
      ["authProviderIdSha256", /ops Auth provider ID digest does not match/],
    ]) {
      await assert.rejects(
        validateDeploymentArtifact({
          publishRoot: root,
          manifest: {
            ...manifest,
            target: {
              ...manifest.target,
              applications: {
                ...manifest.target.applications,
                ops: {
                  ...manifest.target.applications.ops,
                  publicConfigDigests: {
                    ...manifest.target.applications.ops.publicConfigDigests,
                    [field]: "e".repeat(64),
                  },
                },
              },
            },
          },
          deployment,
          sourceState,
        }),
        label,
      );
    }
    await assert.rejects(
      validateDeploymentArtifact({
        publishRoot: root,
        manifest,
        deployment,
        sourceState: { ...sourceState, treeSha256: "c".repeat(64) },
      }),
      /current source state/,
    );

    await writeFile(path, `${payload.toString()}tampered`);
    await assert.rejects(
      validateDeploymentArtifact({
        publishRoot: root,
        manifest,
        deployment,
        sourceState,
      }),
      /size changed after assembly/,
    );
    await writeFile(path, payload);
    await writeFile(join(root, "unrecorded.txt"), "not in manifest");
    await assert.rejects(
      validateDeploymentArtifact({
        publishRoot: root,
        manifest,
        deployment,
        sourceState,
      }),
      /do not contain the same files/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution rejects dirty source even when artifact and target otherwise match", async () => {
  const root = await mkdtemp(join(tmpdir(), "floodrise-firebase-dirty-"));
  const path = join(root, "index.html");
  const payload = Buffer.from("clean artifact bytes");
  await writeFile(path, payload);
  const dirtySource = { ...sourceState, dirty: true };
  const deployment = deploymentRequest([
    "--environment",
    "live",
    "--project",
    "live",
    "--confirm-target",
    "floodrise-production-5305:live",
    "--execute",
  ]);
  const manifest = {
    format: 2,
    target: {
      firebaseSdkVersion: "12.16.0",
      ...deployment.target,
      source: dirtySource,
    },
    artifacts: [
      {
        path: "index.html",
        bytes: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    ],
  };
  try {
    await assert.rejects(
      validateDeploymentArtifact({
        publishRoot: root,
        manifest,
        deployment,
        sourceState: dirtySource,
      }),
      /requires a clean committed source tree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution boundary rereads source and artifact receipts immediately before deploy", async () => {
  const root = await mkdtemp(join(tmpdir(), "floodrise-firebase-boundary-"));
  const path = join(root, "index.html");
  const manifestPath = join(root, "deployment-manifest.json");
  const payload = Buffer.from("receipt-bound artifact");
  await writeFile(path, payload);
  const deployment = deploymentRequest([
    "--environment",
    "live",
    "--project",
    "live",
    "--confirm-target",
    "floodrise-production-5305:live",
    "--execute",
  ]);
  const manifest = {
    format: 2,
    target: {
      firebaseSdkVersion: "12.16.0",
      ...deployment.target,
      source: sourceState,
    },
    artifacts: [
      {
        path: "index.html",
        bytes: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    ],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  let sourceReads = 0;
  const sourceStateReader = () => {
    sourceReads += 1;
    return sourceState;
  };
  try {
    assert.deepEqual(
      await revalidateDeploymentBoundary({
        publishRoot: root,
        manifestPath,
        deployment,
        sourceRoot: "/unused-in-test",
        sourceStateReader,
      }),
      { artifactCount: 1, source: sourceState },
    );
    assert.equal(sourceReads, 1);

    const changedPublicConfiguration = structuredClone(manifest);
    changedPublicConfiguration.target.applications.field.publicConfigDigests
      .appCheckSiteKeySha256 = "e".repeat(64);
    await writeFile(
      manifestPath,
      `${JSON.stringify(changedPublicConfiguration)}\n`,
    );
    await assert.rejects(
      revalidateDeploymentBoundary({
        publishRoot: root,
        manifestPath,
        deployment,
        sourceRoot: "/unused-in-test",
        sourceStateReader,
      }),
      /field App Check site key digest does not match/,
    );
    assert.equal(sourceReads, 2);

    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await writeFile(path, "changed after initial validation");
    await assert.rejects(
      revalidateDeploymentBoundary({
        publishRoot: root,
        manifestPath,
        deployment,
        sourceRoot: "/unused-in-test",
        sourceStateReader,
      }),
      /size changed after assembly/,
    );
    assert.equal(sourceReads, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rendered Hosting CSP uses only the reviewed auth iframe origin", async () => {
  const template = JSON.parse(
    await readFile(new URL("../../firebase.json", import.meta.url), "utf8"),
  );
  const rendered = renderFirebaseConfig(template, targetMap.targets.demo);
  const globalHeaders = rendered.hosting.headers.find(({ source }) => source === "**").headers;
  const csp = globalHeaders.find(
    ({ key }) => key.toLowerCase() === "content-security-policy",
  ).value;
  assert.match(csp, /https:\/\/content-firebaseappcheck\.googleapis\.com/);
  assert.match(csp, /script-src[^;]*https:\/\/apis\.google\.com/);
  assert.match(csp, /frame-src[^;]*https:\/\/apis\.google\.com/);
  assert.match(csp, /frame-src[^;]*https:\/\/floodrise-demo-5305\.firebaseapp\.com/);
  assert.doesNotMatch(csp, /__FLOODRISE_AUTH_DOMAIN__/);
  assert.doesNotMatch(csp, /frame-src[^;]*https:\/\/\*[^;]*firebaseapp\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(
    globalHeaders.find(({ key }) => key.toLowerCase() === "x-frame-options").value,
    "DENY",
  );

  const weakened = structuredClone(template);
  weakened.hosting.headers
    .find(({ source }) => source === "**")
    .headers.find(({ key }) => key === "X-Frame-Options").value = "SAMEORIGIN";
  assert.throws(
    () => renderFirebaseConfig(weakened, targetMap.targets.demo),
    /must retain X-Frame-Options DENY/,
  );
});

test("deployment command pins tooling and passes only the resolved project", () => {
  assert.equal(FIREBASE_TOOLS_VERSION, "15.24.0");
  assert.deepEqual(
    buildFirebaseDeployCommand({
      projectId: "floodrise-demo-5305",
      firebaseConfigPath: "/workspace/firebase.deploy.generated.json",
    }),
    {
      command: "pnpm",
      args: [
        "--allow-build=protobufjs",
        "dlx",
        "firebase-tools@15.24.0",
        "deploy",
        "--only",
        "hosting",
        "--project",
        "floodrise-demo-5305",
        "--config",
        "/workspace/firebase.deploy.generated.json",
      ],
    },
  );
});

test("package deploy entry cannot fall back to Firebase CLI active project state", async () => {
  const [packageText, gitignore] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../.gitignore", import.meta.url), "utf8"),
  ]);
  const packageManifest = JSON.parse(packageText);
  assert.equal(
    packageManifest.scripts["firebase:deploy:hosting"],
    "node scripts/deploy-firebase-hosting.mjs",
  );
  assert.ok(
    !packageManifest.scripts["firebase:deploy:hosting"].includes("firebase-tools"),
    "the package entry must delegate project validation to the fail-closed wrapper",
  );
  assert.match(gitignore, /^\.firebaserc$/m, "the reviewed local project map stays untracked");
  assert.match(
    gitignore,
    /^\.firebase-targets\.json$/m,
    "the reviewed app target map stays untracked",
  );
  assert.match(
    gitignore,
    /^firebase\.deploy\.generated\.json$/m,
    "the rendered exact-domain Firebase config stays generated",
  );
});
