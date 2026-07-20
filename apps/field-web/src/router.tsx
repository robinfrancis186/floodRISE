import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from "@tanstack/react-router";
import { AppShell } from "./App";
import { OfflineQueuePage } from "./pages/OfflineQueuePage";

const AlertsPage = lazyRouteComponent(() => import("./pages/AlertsPage"), "AlertsPage");
const CurrentConditionsPage = lazyRouteComponent(() => import("./pages/CurrentConditionsPage"), "CurrentConditionsPage");
const DemoResetPage = lazyRouteComponent(() => import("./pages/DemoResetPage"), "DemoResetPage");
const loadLowerRiskRoute = () => import("./pages/LowerRiskRoutePage");
const LowerRiskRoutePage = lazyRouteComponent(loadLowerRiskRoute, "LowerRiskRoutePage");
const ReceiptPage = lazyRouteComponent(() => import("./pages/ReceiptPage"), "ReceiptPage");
const ReportFloodingPage = lazyRouteComponent(() => import("./pages/ReportFloodingPage"), "ReportFloodingPage");

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: CurrentConditionsPage });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: CurrentConditionsPage });
const reportRoute = createRoute({ getParentRoute: () => rootRoute, path: "/report", component: ReportFloodingPage });
const demoResetRoute = createRoute({ getParentRoute: () => rootRoute, path: "/demo-reset", component: DemoResetPage });
const queueRoute = createRoute({ getParentRoute: () => rootRoute, path: "/queue", component: OfflineQueuePage });
const alertsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/alerts", component: AlertsPage });
const routeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/lower-risk-route", component: LowerRiskRoutePage });
const receiptRoute = createRoute({ getParentRoute: () => rootRoute, path: "/receipt/$receiptId", component: ReceiptPage });

const routeTree = rootRoute.addChildren([indexRoute, reportRoute, demoResetRoute, queueRoute, alertsRoute, routeRoute, receiptRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent", scrollRestoration: true });

// This safety screen must remain navigable after connectivity drops. Keep it
// code-split for the initial parse, but prewarm the module while the shell is
// online; Workbox also precaches the emitted chunk in installed builds.
if (typeof window !== "undefined" && navigator.onLine) void loadLowerRiskRoute();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
