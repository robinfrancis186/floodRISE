import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoHighImpactViolations(page: Page, surface: string) {
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  const violations = results.violations
    .filter(({ impact }) => impact === "critical" || impact === "serious")
    .map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map((node) => ({
        target: node.target,
        html: node.html,
        failureSummary: node.failureSummary,
      })),
    }));

  expect(violations, `${surface} has serious or critical axe violations`).toEqual([]);
}

test("operations console passes a WCAG AA smoke scan", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://127.0.0.1:55173", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: "Flood impact map" })).toBeVisible();
  await expectNoHighImpactViolations(page, "operations live map");

  await page.getByRole("button", { name: "FloodSignal" }).click();
  await expect(page.getByRole("heading", { name: "Report clusters" })).toBeVisible();
  await page.getByRole("button", { name: /Verify flooding/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectNoHighImpactViolations(page, "FloodSignal review dialog");
});

test("field reporting passes a mobile WCAG AA smoke scan", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("http://127.0.0.1:55174", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Current conditions" })).toBeVisible();
  await expectNoHighImpactViolations(page, "field current conditions");

  await page.getByRole("link", { name: "Report", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Report flooding" })).toBeVisible();
  await expectNoHighImpactViolations(page, "field flood report form");
});
