import { test } from "./fixtures";
import { expect } from "@playwright/test";

test("operations console renders and completes an evidence review", async ({ page }) => {
  await page.setViewportSize({ width: 1570, height: 1000 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://127.0.0.1:55173", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/floodRISE Operations/);
  await expect(page.getByText(/DEMO DATA.*NOT LIVE/).first()).toBeVisible();
  const impactMap = page.getByRole("region", { name: "Flood impact map" });
  await expect(page.getByText("Flood estimate", { exact: true })).toBeVisible();
  await expect(impactMap).toBeVisible();
  await expect(impactMap.getByText("Loading the Chennai map…")).toBeHidden();
  await page.screenshot({ path: "artifacts/screenshots/ops-live.png", fullPage: true });

  await page.getByRole("button", { name: "FloodSignal" }).click();
  await expect(page).toHaveURL(/\/signals$/);
  await expect(page.getByRole("heading", { name: "Report clusters" })).toBeVisible();
  await page.getByRole("button", { name: /Verify flooding/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Verify community corroboration" })).toBeVisible();
  await dialog.getByRole("button", { name: "Verify flooding" }).click();
  await expect(page.getByText("Community corroborated — not an official confirmation")).toBeVisible();
  const corroborationToast = page.getByText("Community corroboration recorded — not an official confirmation.", { exact: true });
  await expect(corroborationToast).toBeVisible();
  await expect(corroborationToast).toBeHidden({ timeout: 6_000 });
  await page.screenshot({ path: "artifacts/screenshots/ops-floodsignal.png", fullPage: true });

  await page.getByRole("button", { name: "Resilience Audit" }).click();
  await expect(page).toHaveURL(/\/resilience$/);
  await expect(page.getByRole("heading", { name: "Chennai resilience priorities" })).toBeVisible();
  await expect(page.getByText("Loading the Chennai map…")).toBeHidden();
  await page.screenshot({ path: "artifacts/screenshots/ops-resilience.png", fullPage: true });

  expect(pageErrors).toEqual([]);
});

test("evacuation approval uses the seeded request and a distinct authorized reviewer", async ({ page, request }, testInfo) => {
  const reset = await request.post("http://127.0.0.1:8787/api/v1/demo/reset", {
    headers: { "X-Demo-Role": "identity_administrator", "X-Demo-User": "playwright-reset-operator" },
  });
  expect(reset.ok()).toBeTruthy();
  await page.setViewportSize({ width: 1570, height: 1000 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://127.0.0.1:55173/evacuation", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("API synced", { exact: true })).toBeVisible({ timeout: 12_000 });
  const reviewButton = page.getByRole("button", { name: "Review guidance approval" });
  await expect(reviewButton).toBeEnabled();
  await page.getByLabel("Active role").selectOption("Verifier");
  await expect(page.getByText(/Active reviewer: Verifier/)).toBeVisible();
  await reviewButton.click();
  const dialog = page.getByRole("dialog", { name: "Approve evacuation guidance" });
  await expect(dialog.getByText(/requires two distinct authorized people/i)).toBeVisible();
  await dialog.getByLabel(/Decision note/i).fill("Independent route, evidence, model and audience review complete.");

  const decisionResponse = page.waitForResponse((response) => response.url().includes("/approvals/") && response.url().endsWith("/decisions"));
  await dialog.getByRole("button", { name: "Approve guidance" }).click();
  const response = await decisionResponse;
  expect(response.status()).toBe(200);
  const decisionRequest = response.request();
  expect(decisionRequest.headers()["x-demo-role"]).toBe("verifier");
  expect(decisionRequest.headers()["x-demo-user"]).toBe("ops-verifier");
  expect(decisionRequest.postDataJSON().expected_version).toBe(1);
  await expect(page.getByText(/server recorded the decision and bound versions/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Guidance approved" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("evacuation-approval.png"), fullPage: false });
  expect(pageErrors).toEqual([]);
});

test("global search opens records, attention items are real, and refresh keeps scenario time", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.goto("http://127.0.0.1:55173", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Search locations, assets, or identifiers" }).click();
  const search = page.getByRole("dialog", { name: "Search floodRISE" });
  await search.getByPlaceholder("Search views, clusters, shelters…").fill("Kendriya Vidyalaya");
  await search.getByRole("option", { name: /Kendriya Vidyalaya Shelter/ }).click();
  await expect(page).toHaveURL(/\/shelters$/);
  await expect(page.getByRole("heading", { name: "Kendriya Vidyalaya Shelter" })).toBeVisible();

  await page.getByRole("button", { name: /Needs attention/ }).click();
  const attention = page.getByRole("region", { name: "Items needing attention" });
  await expect(attention).toBeVisible();
  await expect(attention.getByText(/actionable items|No outstanding reviews or approvals/)).toBeVisible();

  await page.goto("http://127.0.0.1:55173", { waitUntil: "domcontentloaded" });
  const sync = page.locator(".topbar-sync");
  const scenarioTime = (await sync.innerText()).match(/Scenario [^\n]+/)?.[0];
  expect(scenarioTime).toBeTruthy();
  const refresh = page.getByRole("button", { name: "Refresh" });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(sync).toContainText(scenarioTime!);
});
