import { expect, test, type Page } from "@playwright/test";

type RouteExpectation = {
  path: string;
  text: string;
};

const operationsRoutes: RouteExpectation[] = [
  { path: "/", text: "Live Operations" },
  { path: "/signals", text: "Report clusters" },
  { path: "/incidents", text: "Incident Management" },
  { path: "/evacuation", text: "Evacuation Routing" },
  { path: "/shelters", text: "Shelter Operations" },
  { path: "/resilience", text: "Chennai resilience priorities" },
  { path: "/sources", text: "Source Health" },
  { path: "/audit", text: "Audit Log" },
];

const fieldRoutes: RouteExpectation[] = [
  { path: "/", text: "Current conditions" },
  { path: "/report", text: "Report flooding" },
  { path: "/queue", text: "Offline queue" },
  { path: "/alerts", text: "Alerts" },
  { path: "/lower-risk-route", text: "Lower-risk route" },
  { path: "/helplines", text: "Emergency helplines" },
  { path: "/demo-reset", text: "Reset this demo device" },
];

function collectBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  return failures;
}

test("all operations routes render from direct URLs without browser errors", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const failures = collectBrowserFailures(page);

  for (const route of operationsRoutes) {
    await page.goto(`http://127.0.0.1:55173${route.path}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(route.text, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/DEMO DATA.*NOT LIVE/).first()).toBeVisible();
  }

  expect(failures).toEqual([]);
});

test("all field workflows render at 360 by 800 without browser errors", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const failures = collectBrowserFailures(page);

  for (const route of fieldRoutes) {
    await page.goto(`http://127.0.0.1:55174${route.path}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: route.text, exact: true }).first()).toBeVisible();
    await expect(page.getByText(/DEMO DATA.*NOT LIVE/).first()).toBeVisible();
  }

  expect(failures).toEqual([]);
});
