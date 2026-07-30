import {
  CloudBootstrapError,
  type ClientCloudEnvironment,
  type FirebaseCloudSdk,
} from "@floodrise/cloud-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { router } from "./router";
import {
  bootstrapFieldCloudSecurity,
  lockFieldToOfflineAccess,
  validateFieldCloudDeployment,
} from "./lib/cloud-bootstrap";
import {
  FieldCloudAccessProvider,
  type FieldCloudAccess,
} from "./lib/cloud-access";
import {
  configureFieldApiRuntime,
  fetchFieldIncidentBootstrap,
  FieldBootstrapError,
} from "./lib/api";
import {
  DEMO_FIELD_RUNTIME,
  UNAVAILABLE_LIVE_FIELD_RUNTIME,
} from "./lib/field-runtime";
import { isForcedOfflineMode } from "./lib/network";
import { deleteLegacyFieldApiCache } from "./lib/service-worker-cache";

export type FieldApplicationStart = {
  status: "ready" | "offline_ready" | "sign_in_required" | "blocked";
  stop: () => void;
};

export type FieldApplicationStartOptions = {
  bootstrapTimeoutMs?: number;
};

function CloudLoadingScreen() {
  return (
    <main
      className="cloud-access-page"
      id="main-content"
      aria-busy="true"
    >
      <section
        className="cloud-access-panel cloud-loading-panel"
        aria-labelledby="cloud-access-title"
        role="status"
        aria-live="polite"
      >
        <span className="cloud-access-product">floodRISE Field</span>
        <span className="cloud-loading-mark" aria-hidden />
        <h1 id="cloud-access-title">Preparing secure access</h1>
        <p>Checking identity and device verification. No report, alert, or route request has started.</p>
      </section>
    </main>
  );
}

function CloudAccessScreen({
  kind,
  detail,
  onSignIn,
  onRetry,
}: {
  kind: "sign_in" | "blocked";
  detail: string;
  onSignIn?: () => Promise<void>;
  onRetry?: () => void;
}) {
  const [signInError, setSignInError] = useState("");
  const [starting, setStarting] = useState(false);
  const startSignIn = async () => {
    if (!onSignIn || starting) return;
    setStarting(true);
    setSignInError("");
    try {
      await onSignIn();
    } catch {
      setSignInError("Sign-in could not be started. Try again or contact the incident desk.");
      setStarting(false);
    }
  };

  return (
    <main className="cloud-access-page" id="main-content">
      <section className="cloud-access-panel" aria-labelledby="cloud-access-title">
        <span className="cloud-access-product">floodRISE Field</span>
        <h1 id="cloud-access-title">
          {kind === "sign_in" ? "Verify your identity" : "Live access is paused"}
        </h1>
        <p>{detail}</p>
        {onSignIn ? (
          <button
            className="cloud-access-action"
            type="button"
            disabled={starting}
            onClick={() => void startSignIn()}
          >
            {starting ? "Opening identity provider…" : "Continue with secure sign-in"}
          </button>
        ) : null}
        {onRetry ? (
          <button
            className="cloud-access-action cloud-access-secondary"
            type="button"
            onClick={onRetry}
          >
            Try secure access again
          </button>
        ) : null}
        {signInError ? <p className="cloud-access-error" role="alert">{signInError}</p> : null}
        <small>No live report or route request starts until identity and device verification are ready.</small>
      </section>
    </main>
  );
}

function renderApplication(root: Root, access: FieldCloudAccess) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
    },
  });
  root.render(
    <StrictMode>
      <FieldCloudAccessProvider access={access}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </FieldCloudAccessProvider>
    </StrictMode>,
  );
}

function isOffline() {
  return !navigator.onLine || isForcedOfflineMode();
}

export async function startFieldApplication(
  container: HTMLElement,
  environment: ClientCloudEnvironment = import.meta.env,
  firebaseSdk?: FirebaseCloudSdk,
  options: FieldApplicationStartOptions = {},
): Promise<FieldApplicationStart> {
  const root = createRoot(container);
  let stopped = false;
  let attemptVersion = 0;
  let disposeCloudSecurity: () => void = () => undefined;
  let resolvedDeployment: "demo" | "live" | null = null;

  const renderLoading = () => {
    flushSync(() => root.render(<CloudLoadingScreen />));
  };

  const retry = () => {
    void attemptBootstrap();
  };

  const renderOfflineApplication = () => {
    disposeCloudSecurity();
    disposeCloudSecurity = lockFieldToOfflineAccess();
    configureFieldApiRuntime(UNAVAILABLE_LIVE_FIELD_RUNTIME);
    renderApplication(root, {
      mode: "offline_only",
      runtime: UNAVAILABLE_LIVE_FIELD_RUNTIME,
      retry,
    });
  };

  const attemptBootstrap = async (): Promise<FieldApplicationStart["status"]> => {
    const version = ++attemptVersion;
    let liveDeployment = environment.VITE_DEMO_MODE === "false";
    disposeCloudSecurity();
    disposeCloudSecurity = () => undefined;
    if (liveDeployment) {
      configureFieldApiRuntime(UNAVAILABLE_LIVE_FIELD_RUNTIME);
    }
    renderLoading();
    try {
      // Historical workers cached API responses. Purge those stores on every
      // startup path, including offline relaunch and sign-in-required states.
      await deleteLegacyFieldApiCache();
      if (stopped || version !== attemptVersion) return "blocked";
      liveDeployment = validateFieldCloudDeployment(environment) === "live";
      resolvedDeployment = liveDeployment ? "live" : "demo";
      if (liveDeployment) {
        configureFieldApiRuntime(UNAVAILABLE_LIVE_FIELD_RUNTIME);
      }
      // Memory-only authentication is intentionally absent after an installed
      // PWA relaunch. When the browser is already offline, skip provider work
      // entirely and open the local-only shell without a network grace period.
      if (liveDeployment && isOffline()) {
        renderOfflineApplication();
        return "offline_ready";
      }
      const result = await bootstrapFieldCloudSecurity(
        environment,
        firebaseSdk,
        options.bootstrapTimeoutMs,
      );
      if (stopped || version !== attemptVersion) {
        result.dispose();
        return "blocked";
      }
      disposeCloudSecurity = result.dispose;
      if (result.status === "sign_in_required") {
        if (liveDeployment && isOffline()) {
          renderOfflineApplication();
          return "offline_ready";
        }
        root.render(
          <CloudAccessScreen
            kind="sign_in"
            detail="Sign in through the authority-approved identity provider before submitting or synchronizing flood reports."
            onSignIn={result.signIn}
          />,
        );
        return "sign_in_required";
      }

      if (liveDeployment) {
        const runtime = await fetchFieldIncidentBootstrap(
          options.bootstrapTimeoutMs,
        );
        if (stopped || version !== attemptVersion) return "blocked";
        configureFieldApiRuntime(runtime);
        renderApplication(root, { mode: "full", runtime });
      } else {
        configureFieldApiRuntime(DEMO_FIELD_RUNTIME);
        renderApplication(root, {
          mode: "full",
          runtime: DEMO_FIELD_RUNTIME,
        });
      }
      return "ready";
    } catch (error) {
      if (stopped || version !== attemptVersion) return "blocked";
      if (liveDeployment) {
        configureFieldApiRuntime(UNAVAILABLE_LIVE_FIELD_RUNTIME);
      }
      const bootstrapError = error instanceof CloudBootstrapError ? error : null;
      const incidentBootstrapError = error instanceof FieldBootstrapError
        ? error
        : null;
      const isTransientCloudFailure = bootstrapError?.code === "IDENTITY_UNAVAILABLE"
        || bootstrapError?.code === "APP_CHECK_UNAVAILABLE";
      const canUseOfflineShell = liveDeployment
        && isOffline()
        && isTransientCloudFailure;
      if (canUseOfflineShell) {
        renderOfflineApplication();
        return "offline_ready";
      }
      root.render(
        <CloudAccessScreen
          kind="blocked"
          detail={bootstrapError?.message
            ?? incidentBootstrapError?.message
            ?? "Cloud security could not be initialized. No live request was started."}
          onRetry={retry}
        />,
      );
      return "blocked";
    }
  };

  const status = await attemptBootstrap();
  return {
    status,
    stop: () => {
      if (stopped) return;
      stopped = true;
      attemptVersion += 1;
      disposeCloudSecurity();
      configureFieldApiRuntime(
        resolvedDeployment === "demo"
          ? DEMO_FIELD_RUNTIME
          : UNAVAILABLE_LIVE_FIELD_RUNTIME,
      );
      root.unmount();
    },
  };
}
