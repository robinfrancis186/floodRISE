import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("street tiles load with operational overlays and no duplicate place labels", async ({ page }) => {
  const tileRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://tile.openstreetmap.org/")) tileRequests.push(request.url());
  });
  await page.goto("http://127.0.0.1:55173");
  await expect(page.getByText("Loading the Chennai map…")).toBeHidden();
  await expect(page.locator(".fr-map-attribution")).toContainText("Street map");
  await expect(page.locator(".fr-map-place-label")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^report cluster: VEL-042/ })).toBeVisible();
  await page.getByRole("button", { name: "+3h", exact: true }).click();
  await expect(page.getByRole("button", { name: "+3h", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(tileRequests.length).toBeGreaterThan(0);
});

test("failed street tiles fall back to a usable packaged map", async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
  await page.goto("http://127.0.0.1:55173");
  await expect(page.locator(".fr-map-attribution")).toContainText("Offline map");
  await expect(page.getByText("Loading the Chennai map…")).toBeHidden();
  await expect(page.locator(".fr-map-place-label").first()).toBeAttached();
  await expect(page.getByRole("button", { name: /^report cluster: VEL-042/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeEnabled();
  await expect(page.getByText(/Interactive map unavailable/)).toBeHidden();
});

test("real facilities can be searched, filtered, and switched to Kerala without scenario claims", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:55173");
  await expect(page.getByText("Loading the Chennai map…")).toBeHidden();
  await page.getByRole("button", { name: "Places · 346" }).click();
  const accessibility = await new AxeBuilder({ page }).include(".fr-map-facilities").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  await page.getByLabel("Find a mapped place").fill("Velachery Police Station");
  await page.getByRole("button", { name: /Velachery Police Station Police/ }).click();
  await expect(page.getByRole("link", { name: "View OpenStreetMap record ↗" }))
    .toHaveAttribute("href", "https://www.openstreetmap.org/node/8645780209");
  const layout = await page.locator(".fr-map-canvas-shell").evaluate((shell) => {
    const bounds = shell.getBoundingClientRect();
    const canvas = shell.querySelector(".fr-map-canvas")!.getBoundingClientRect();
    const panel = shell.querySelector(".fr-map-facilities-panel")!.getBoundingClientRect();
    const attribution = shell.querySelector(".fr-map-attribution")!.getBoundingClientRect();
    return { scroll: shell.scrollTop, canvasOffset: canvas.top - bounds.top, panelBottom: panel.bottom, attributionTop: attribution.top };
  });
  expect(layout.scroll).toBe(0);
  expect(layout.canvasOffset).toBeLessThanOrEqual(1);
  expect(layout.panelBottom).toBeLessThan(layout.attributionTop);
  await page.route("**/in-kl/osm-places.geojson", (route) => route.fulfill({ status: 503, body: "Test outage" }));
  await page.getByLabel("Region", { exact: true }).selectOption("kerala");
  await expect(page.getByText("Could not load this region.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Places · 1" })).toBeVisible();
  await page.unroute("**/in-kl/osm-places.geojson");
  await page.getByLabel("Region", { exact: true }).selectOption("kerala");
  await expect(page.getByText("Kerala location baseline", { exact: true })).toBeVisible();
  await expect(page.getByText("No Kerala flood estimate or evacuation guidance is available.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /^shelter:/ })).toHaveCount(0);
  await page.getByLabel("Hospitals", { exact: true }).uncheck();
  await page.getByLabel("Police", { exact: true }).uncheck();
  await page.getByLabel("Fire stations", { exact: true }).uncheck();
  await expect(page.getByText("Select a category or try another name.")).toBeVisible();
  await page.getByLabel("Region", { exact: true }).selectOption("chennai");
  await expect(page.getByRole("button", { name: /^shelter:/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Close places" }).click();
  await page.getByRole("button", { name: "FloodSignal", exact: true }).click();
  await expect(page.getByRole("heading", { name: "FloodSignal Review", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
