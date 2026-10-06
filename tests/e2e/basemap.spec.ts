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
