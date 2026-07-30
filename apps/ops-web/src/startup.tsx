import {
  CloudBootstrapError,
  type ClientCloudEnvironment,
  type FirebaseCloudSdk,
} from "@floodrise/cloud-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import {
  fetchAuthenticatedOperationsPrincipal,
  type AuthenticatedOperationsPrincipal,
} from "./lib/api";
import { bootstrapOperationsCloudSecurity } from "./lib/cloud-bootstrap";

export type OperationsApplicationStart = {
  status: "ready" | "sign_in_required" | "blocked";
  stop: () => void;
};

export type OperationsStartupOptions = {
  bootstrapTimeoutMs?: number;
};

function CloudLoadingScreen() {
  return (
    <main className="cloud-access-page" id="main-content">
      <section
        className="cloud-access-panel cloud-loading-panel"
        role="status"
        aria-live="polite"
        aria-labelledby="cloud-loading-title"
      >
        <span className="cloud-access-product">floodRISE Operations</span>
        <span className="cloud-loading-indicator" aria-hidden />
        <h1 id="cloud-loading-title">Verifying operations access</h1>
        <p>Checking device integrity and your authority-approved staff session.</p>
        <small>No operational data or live event connection starts before verification completes.</small>
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
  onRetry?: () => Promise<void>;
}) {
  const [actionError, setActionError] = useState("");
  const [starting, setStarting] = useState(false);
  const startAction = async () => {
    const action = onSignIn ?? onRetry;
    if (!action || starting) return;
    setStarting(true);
    setActionError("");
    try {
      await action();
    } catch {
      setActionError(
        onSignIn
          ? "Sign-in could not be started. Try again or contact the identity administrator."
          : "Verification could not be restarted. Check connectivity and try again.",
      );
      setStarting(false);
    }
  };

  return (
    <main className="cloud-access-page" id="main-content">
      <section className="cloud-access-panel" aria-labelledby="cloud-access-title">
        <span className="cloud-access-product">floodRISE Operations</span>
        <h1 id="cloud-access-title">
          {kind === "sign_in" ? "Staff sign-in required" : "Operations access is paused"}
        </h1>
        <p>{detail}</p>
        {onSignIn || onRetry ? (
          <button
            className="cloud-access-action"
            type="button"
            disabled={starting}
            onClick={() => void startAction()}
          >
            {onSignIn
              ? starting ? "Opening identity provider…" : "Continue with staff sign-in"
              : starting ? "Restarting verification…" : "Retry verification"}
          </button>
        ) : null}
        {actionError ? <p className="cloud-access-error" role="alert">{actionError}</p> : null}
        <small>No operational API, approval, or event-stream request starts until verification is ready.</small>
      </section>
    </main>
  );
}

function renderApplication(
  root: Root,
  mode: "demo" | "live",
  principal?: AuthenticatedOperationsPrincipal,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        retryDelay: 250,
        staleTime: 15_000,
        refetchOnWindowFocus: false,
      },
    },
  });
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App
          mode={mode}
          initialRole={principal?.role}
          principalUserId={principal?.userId}
        />
      </QueryClientProvider>
    </StrictMode>,
  );
  return () => queryClient.clear();
}

function blockedAccessDetail(error: unknown) {
  if (!(error instanceof CloudBootstrapError)) {
    return "The authenticated staff profile could not be verified by the operations service. No operational workspace was opened.";
  }
  if (error.code === "INVALID_CONFIGURATION") {
    return "Live operations is not configured correctly. Contact the identity administrator or retry after deployment settings are corrected.";
  }
  if (error.code === "APP_CHECK_UNAVAILABLE") {
    return "Device verification is unavailable. No operational workspace was opened.";
  }
  return "Staff identity verification did not complete. Check connectivity and try again.";
}

export async function startOperationsApplication(
  container: HTMLElement,
  environment: ClientCloudEnvironment = import.meta.env,
  firebaseSdk?: FirebaseCloudSdk,
  options: OperationsStartupOptions = {},
): Promise<OperationsApplicationStart> {
  const root = createRoot(container);
  let status: OperationsApplicationStart["status"] = "blocked";
  let stopped = false;
  let generation = 0;
  let disposeCloudSecurity: () => void = () => undefined;
  let clearApplicationQueries: () => void = () => undefined;

  const attemptBootstrap = async (): Promise<void> => {
    const attemptGeneration = ++generation;
    disposeCloudSecurity();
    disposeCloudSecurity = () => undefined;
    clearApplicationQueries();
    clearApplicationQueries = () => undefined;
    root.render(<CloudLoadingScreen />);

    try {
      const result = await bootstrapOperationsCloudSecurity(
        environment,
        firebaseSdk,
        options.bootstrapTimeoutMs,
      );
      if (stopped || attemptGeneration !== generation) {
        result.dispose();
        return;
      }
      disposeCloudSecurity = result.dispose;
      if (result.status === "sign_in_required") {
        status = "sign_in_required";
        root.render(
          <CloudAccessScreen
            kind="sign_in"
            detail="Use the authority-approved OIDC provider. Staff roles, recent authentication, and two-person approvals remain server-enforced."
            onSignIn={result.signIn}
          />,
        );
        return;
      }

      if (result.status === "demo") {
        clearApplicationQueries = renderApplication(root, "demo");
      } else {
        const principal = await fetchAuthenticatedOperationsPrincipal();
        if (stopped || attemptGeneration !== generation) {
          result.dispose();
          return;
        }
        clearApplicationQueries = renderApplication(root, "live", principal);
      }
      status = "ready";
    } catch (error) {
      if (stopped || attemptGeneration !== generation) return;
      disposeCloudSecurity();
      disposeCloudSecurity = () => undefined;
      status = "blocked";
      root.render(
        <CloudAccessScreen
          kind="blocked"
          detail={blockedAccessDetail(error)}
          onRetry={attemptBootstrap}
        />,
      );
    }
  };

  const started: OperationsApplicationStart = {
    get status() {
      return status;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      generation += 1;
      clearApplicationQueries();
      disposeCloudSecurity();
      root.unmount();
    },
  };

  await attemptBootstrap();
  return started;
}
