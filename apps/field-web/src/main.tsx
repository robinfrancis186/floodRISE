import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./lib/i18n";
import { router } from "./router";
import "./styles.css";
import { ErrorBoundary, SessionGate } from "@floodrise/ui";
import { configureFieldAccount } from "./lib/db";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false }
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ErrorBoundary><SessionGate onAuthenticated={configureFieldAccount}><RouterProvider router={router} /></SessionGate></ErrorBoundary>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>
);
