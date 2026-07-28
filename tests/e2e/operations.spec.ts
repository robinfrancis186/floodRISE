import { expect, test } from "@playwright/test";

test("operations console renders and completes an evidence review", async ({ page, request }) => {
  const reset = await request.post("http://127.0.0.1:8787/api/v1/demo/reset", {
    headers: { "X-Demo-Role": "identity_administrator", "X-Demo-User": "playwright-reset-operator" },
  });
  expect(reset.ok()).toBeTruthy();
  await page.setViewportSize({ width: 1570, height: 1000 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://127.0.0.1:55173", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/floodRISE Operations/);
  await expect(page.getByText(/DEMO DATA.*NOT LIVE/).first()).toBeVisible();
  const impactMap = page.getByRole("region", { name: "Flood impact map" });
  await expect(impactMap.getByText("Rapid impact estimate", { exact: true })).toBeVisible();
  await expect(impactMap).toBeVisible();
  await expect(impactMap.getByText("Loading the detailed Kerala map…")).toBeHidden();
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
  await expect(page.getByRole("heading", { name: "Kerala resilience priorities" })).toBeVisible();
  await expect(page.getByText("Loading the detailed Kerala map…")).toBeHidden();
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
  await expect(page.getByText(/Route geometry is not displayed.*do not infer a path/i)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Map legend" }).getByText("Lower-risk route", { exact: true })).toHaveCount(0);
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

test("operations controls filter, export, navigate, and preserve authority boundaries", async ({ page }) => {
  await page.setViewportSize({ width: 1570, height: 1000 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://127.0.0.1:55173/incidents", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Create incident unavailable in demo" })).toBeDisabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export incident brief" }).click();
  expect((await download).suggestedFilename()).toContain("inc-kerala-flood-2023-demo-brief-demo.txt");
  await expect(page.getByText(/Demo brief downloaded.*not an official public warning/i)).toBeVisible();
  await page.getByRole("button", { name: "Open command workspace" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:55173/");

  await page.getByRole("button", { name: "FloodSignal" }).click();
  await page.getByLabel("Ward").selectOption("Ward 121");
  await expect(page.getByRole("complementary", { name: /Kadungalloor evidence review/ })).toBeVisible();
  await page.getByLabel("Freshness").selectOption("5m");
  await expect(page.getByText("No actionable cluster")).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify flooding" })).toHaveCount(0);

  await page.getByRole("button", { name: "Resilience Audit" }).click();
  await page.getByLabel("Event range").selectOption("2026");
  await page.getByLabel("Asset type").selectOption("Road");
  await expect(page.getByText("No priorities match")).toBeVisible();
  await page.getByLabel("Asset type").selectOption("All");
  await page.getByLabel("Recurring flooding").uncheck();
  await expect(page.getByLabel("Recurring flooding")).not.toBeChecked();
  await page.getByRole("button", { name: "Add engineer note" }).click();
  const noteDialog = page.getByRole("dialog", { name: "Add engineer note" });
  await noteDialog.getByLabel(/Engineer note/).fill("Inspect the upstream grate before the next monsoon drill.");
  await noteDialog.getByRole("button", { name: "Save local note" }).click();
  await expect(page.getByText("Inspect the upstream grate before the next monsoon drill.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request authority review" })).toBeDisabled();

  expect(pageErrors).toEqual([]);
});
