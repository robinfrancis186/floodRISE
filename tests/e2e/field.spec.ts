import { expect, test } from "@playwright/test";

const smallJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDzSiiiv6lP5nP/2Q==",
  "base64",
);

test("field PWA stores an offline report and blocks fresh route claims", async ({ context, page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://127.0.0.1:55174", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/floodRISE Field/);
  await expect(page.getByText(/DEMO DATA.*NOT LIVE/).first()).toBeVisible();
  await page.screenshot({ path: "artifacts/screenshots/field-conditions.png", fullPage: true });

  await page.getByRole("link", { name: "Report", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Report flooding" })).toBeVisible();
  await page.getByRole("radio", { name: /Knee/ }).click();
  await page.getByRole("radio", { name: "Impassable" }).click();
  await page.getByRole("button", { name: /Blocked drain/ }).click();
  await page.getByLabel("Add a short note").fill("Water rising beside the blocked drain; people are turning back.");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({
    path: "artifacts/screenshots/field-report.png",
    fullPage: true,
    // Full-page stitching can pull the intentionally off-screen fixed skip link
    // into a later tile. Hide only that capture artifact; keyboard coverage still
    // verifies the real focusable control in component tests.
    style: ".skip-link { display: none !important; }",
  });

  await context.setOffline(true);
  await expect(page.getByRole("button", { name: /Save report offline/ })).toBeVisible();
  await page.getByRole("button", { name: /Save report offline/ }).click();
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.getByRole("heading", { name: "Offline queue" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Waiting to submit" })).toBeVisible();

  await page.getByRole("link", { name: "Route" }).click();
  await expect(page.getByRole("heading", { name: "Lower-risk route" })).toBeVisible();
  await expect(page.getByText("Fresh route guidance unavailable offline")).toBeVisible();
  await expect(page.getByText(/must not be treated as safe/i)).toBeVisible();
  await page.screenshot({ path: "artifacts/screenshots/field-offline-route.png", fullPage: true });

  expect(pageErrors).toEqual([]);
});

test("field demo reset requires explicit confirmation and clears only this browser profile", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://127.0.0.1:55174/report?offline=1", { waitUntil: "domcontentloaded" });
  await page.getByRole("radio", { name: /Knee/ }).click();
  await page.getByRole("radio", { name: "Impassable" }).click();
  await expect(page.getByRole("button", { name: /Save report offline/ })).toBeVisible();
  await page.getByRole("button", { name: /Save report offline/ }).click();
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();

  await page.goto("http://127.0.0.1:55174/demo-reset", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Reset this demo device" })).toBeVisible();
  await expect(page.getByText("One browser profile at a time")).toBeVisible();
  await expect(page.getByText("This browser profile is clean")).toBeHidden();

  await page.getByRole("button", { name: "Verify and clear this demo device" }).click();
  await expect(page.getByText("This browser profile is clean")).toBeVisible();
  await expect(page.getByText(/Removed 1 unsent draft and 0 receipts/)).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/field-demo-reset.png",
    fullPage: true,
    style: ".skip-link { display: none !important; }",
  });

  await page.getByRole("link", { name: "Open offline queue" }).click();
  await expect(page.getByText("New offline reports will appear here")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("field photo evidence reaches a private sanitized state before report receipt", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://127.0.0.1:55174/report", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').setInputFiles({
    name: "field-evidence.jpg",
    mimeType: "image/jpeg",
    buffer: smallJpeg,
  });
  await expect(page.getByAltText("Selected flood evidence preview")).toBeVisible();
  await page.getByRole("button", { name: /Submit report/ }).click();

  await expect(page).toHaveURL(/\/receipt\//);
  await expect(page.getByRole("heading", { name: "Report received" })).toBeVisible();
  await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});
