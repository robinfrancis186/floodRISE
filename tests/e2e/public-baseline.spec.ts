import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("field PWA keeps a downloaded Kerala baseline usable offline", async ({ page, context }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("http://127.0.0.1:55175/field/");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect(page.getByText("Loading the Chennai map…")).toBeHidden();
  await page.getByRole("button", { name: "Places · 346" }).click();
  await page.getByLabel("Region", { exact: true }).selectOption("kerala");
  await expect(page.getByRole("button", { name: "Places · 5971" })).toBeVisible();
  await page.getByLabel("Find a mapped place").fill("General Hospital Ernakulam");
  await page.getByRole("button", { name: /General Hospital Ernakulam Hospitals/ }).click();
  await expect(page.getByRole("link", { name: "View OpenStreetMap record ↗" }))
    .toHaveAttribute("href", "https://www.openstreetmap.org/way/755600802");
  await page.getByLabel("Region", { exact: true }).selectOption("chennai");
  await expect(page.getByRole("button", { name: "Places · 346" })).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel("Region", { exact: true }).selectOption("kerala");
  await expect(page.getByRole("button", { name: "Places · 5971" })).toBeVisible();
  await expect(page.getByText("Could not load this region.", { exact: false })).toBeHidden();
  await expect(page.getByRole("button", { name: /^shelter:/ })).toHaveCount(0);
  for (const kind of ["Schools", "Colleges", "Community centres"]) await page.getByLabel(kind, { exact: true }).check();
  await expect(page.getByRole("button", { name: "Places · 23586" })).toBeVisible();
});
