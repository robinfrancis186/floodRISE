import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@floodrise/map/styles.css";
import "@floodrise/ui/styles.css";
import "./styles.css";
import { App } from "./App";
import { ErrorBoundary, SessionGate } from "@floodrise/ui";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary><SessionGate><App /></SessionGate></ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);
