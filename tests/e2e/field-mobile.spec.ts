import { expect, test, type Browser, type Page } from "@playwright/test";

const FIELD_URL = "http://127.0.0.1:55174";
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XTXxWQAAAABJRU5ErkJggg==",
  "base64",
);

const viewports = [
  { name: "320x568", width: 320, height: 568 },
  { name: "360x800", width: 360, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "844x390", width: 844, height: 390 },
] as const;

const routes = [
  { name: "Current Conditions", path: "/", heading: "Current conditions" },
  { name: "Report Flooding", path: "/report", heading: "Report flooding" },
  { name: "Offline Queue", path: "/queue", heading: "Offline queue" },
  { name: "Alerts", path: "/alerts", heading: "Alerts" },
  {
    name: "Report Receipt/Status",
    path: "/receipt/mobile-compatibility-missing",
    text: "Receipt not available on this device",
  },
  { name: "Lower-Risk Route", path: "/lower-risk-route", heading: "Lower-risk route" },
] as const;

type BrowserFailure = { kind: "console" | "page"; message: string };

function collectBrowserFailures(page: Page) {
  const failures: BrowserFailure[] = [];
  page.on("pageerror", (error) => failures.push({ kind: "page", message: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push({ kind: "console", message: message.text() });
  });
  return failures;
}

async function createTouchPage(browser: Browser, viewport: (typeof viewports)[number]) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();

  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: transparentPng,
  }));
  await page.route("**/api/v1/reports/mobile-compatibility-missing", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ unavailable: true }),
  }));
  await page.route("**/api/v1/routes/recommend", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      generated_at: "2023-12-04T14:10:00.000Z",
      alternatives: [
        {
          id: "route-mobile-audit",
          label: "Mobile audit route",
          duration_min: 18,
          distance_km: 3.4,
          shelter: "Aluva School Shelter",
          risk: "LOWER",
          reasons: [
            "Avoids the corroborated flooding cluster",
            "No authorized closures on this route",
          ],
          model_version: "model-mobile-audit",
          evidence_version: "evidence-mobile-audit",
          valid_until: "2023-12-04T14:30:00.000Z",
        },
      ],
      no_route_reason: null,
    }),
  }));

  return { context, page };
}

async function expectResponsiveLayout(page: Page, surface: string) {
  const audit = await page.evaluate(async () => {
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    const visible = (element: Element) => {
      const htmlElement = element as HTMLElement;
      const style = getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const label = (element: Element) =>
      element.getAttribute("aria-label")?.trim()
      || element.textContent?.replace(/\s+/g, " ").trim().slice(0, 100)
      || element.tagName.toLowerCase();
    const controls = [
      ...document.querySelectorAll(
        ".field-header button, .bottom-navigation-item, main button, main a, "
          + "main input:not([type='file']), main textarea, main select, main .photo-picker",
      ),
    ].filter(visible).filter((element) =>
      !element.closest(".fr-flood-map")
      && !element.classList.contains("skip-link")
      && !element.closest(".fr-map-attribution"),
    );

    const clippedControls: string[] = [];
    const smallTargets: Array<{ label: string; width: number; height: number }> = [];
    const unreachableControls: string[] = [];

    for (const element of controls) {
      const htmlElement = element as HTMLElement;
      htmlElement.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const rect = htmlElement.getBoundingClientRect();
      if (rect.left < -1 || rect.right > window.innerWidth + 1) {
        clippedControls.push(label(element));
      }
      if (rect.width < 44 || rect.height < 44) {
        smallTargets.push({
          label: label(element),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
      if (!(htmlElement instanceof HTMLButtonElement && htmlElement.disabled)) {
        const centerX = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const centerY = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(centerX, centerY);
        if (
          rect.bottom <= 0
          || rect.top >= window.innerHeight
          || !hit
          || !(hit === htmlElement || htmlElement.contains(hit))
        ) {
          unreachableControls.push(label(element));
        }
      }
    }

    const banner = document.querySelector(".field-app > .skip-link + [role='status']") as HTMLElement | null;
    const result = {
      horizontalOverflow: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ) - window.innerWidth,
      clippedControls,
      smallTargets,
      unreachableControls,
      bannerOverflow: banner ? banner.scrollHeight - banner.clientHeight : 0,
      bottomNavigationItems: document.querySelectorAll(".bottom-navigation-item").length,
    };
    document.documentElement.style.scrollBehavior = previousScrollBehavior;
    return result;
  });

  expect(audit.horizontalOverflow, `${surface}: horizontal overflow`).toBeLessThanOrEqual(1);
  expect(audit.clippedControls, `${surface}: horizontally clipped controls`).toEqual([]);
  expect(audit.smallTargets, `${surface}: controls smaller than 44 by 44 pixels`).toEqual([]);
  expect(audit.unreachableControls, `${surface}: controls blocked or off-screen after scrolling`).toEqual([]);
  expect(audit.bannerOverflow, `${surface}: clipped DEMO DATA banner`).toBeLessThanOrEqual(1);
}

test.describe("Field PWA touch and responsive compatibility", () => {
  for (const viewport of viewports) {
    test(`${viewport.name} keeps every Field workflow usable`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await createTouchPage(browser, viewport);
      const failures = collectBrowserFailures(page);

      await page.goto(FIELD_URL, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Current conditions" })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.locator(".skip-link")).toBeFocused();
      await expect(page.locator(".skip-link")).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(page.locator("#main-content")).toBeFocused();
      await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();
      await page.getByRole("link", { name: "Alerts", exact: true }).tap();
      await expect(page).toHaveURL(/\/alerts$/);

      for (const route of routes) {
        if (route.name === "Alerts") {
          await page.route("**/api/v1/alerts**", (request) => request.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ invalid: true }),
          }));
        }
        await page.goto(`${FIELD_URL}${route.path}`, { waitUntil: "domcontentloaded" });
        if ("heading" in route) {
          await expect(page.getByRole("heading", { name: route.heading, exact: true }).first()).toBeVisible();
        } else {
          await expect(page.getByText(route.text, { exact: true })).toBeVisible();
        }

        if (route.name === "Report Flooding") {
          await page.getByRole("radio", { name: /Knee/ }).tap();
          await page.getByRole("radio", { name: "Difficult" }).tap();
          await page.getByRole("button", { name: /Blocked drain/ }).tap();
          await page.getByLabel("Add a short note").fill("Touch compatibility check");
          await expect(page.getByRole("button", { name: "Close report form" })).toBeVisible();
          await expect(page.getByRole("button", { name: /Adjust pin/ })).toBeVisible();
          await expect(page.locator(".report-map button.fr-map-marker")).toHaveCount(0);
        }

        if (route.name === "Alerts") {
          await expect(page.getByText("Alert API unavailable", { exact: true })).toBeVisible();
          await expect(page.getByText(/not a current alert feed/i)).toBeVisible();
          await page.unroute("**/api/v1/alerts**");
        }

        if (route.name === "Lower-Risk Route") {
          const review = page.getByRole("button", {
            name: "Review Mobile audit route to Aluva School Shelter",
          });
          await expect(review).toBeVisible();
          await review.tap();
          await expect(review).toHaveAttribute("aria-pressed", "true");
          await expect(page.getByRole("status", { name: "Selected route details" })).toContainText(
            "model-mobile-audit",
          );
          await expect(page.getByRole("note", { name: "Route map safety boundary" })).toContainText(
            "Route geometry is not provided",
          );
        }

        await expectResponsiveLayout(page, `${viewport.name} ${route.name}`);
        if (route.name !== "Report Flooding") {
          expect(
            await page.locator(".bottom-navigation-item").count(),
            `${viewport.name} ${route.name}: bottom navigation item count`,
          ).toBe(5);
        }
      }

      expect(failures).toEqual([]);
      await context.close();
    });
  }

  test("standalone shell reserves the top safe area for the DEMO DATA banner", async ({
    browser,
  }) => {
    const viewport = viewports.find(({ name }) => name === "390x844")!;
    const { context, page } = await createTouchPage(browser, viewport);

    await page.goto(FIELD_URL, { waitUntil: "domcontentloaded" });
    const banner = page.locator(".field-app > .skip-link + [role='status']");
    await expect(banner).toBeVisible();
    const baselineHeight = (await banner.boundingBox())?.height ?? 0;

    await page.locator(".field-app").evaluate((element) => {
      (element as HTMLElement).style.setProperty("--field-safe-area-top", "32px");
    });

    await expect.poll(async () => (await banner.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      baselineHeight + 31,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(1);
    await context.close();
  });

  test("390x844 touch flow keeps offline queue, confirmation dialog, route warning, and receipt reachable", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const viewport = viewports.find(({ name }) => name === "390x844")!;
    const { context, page } = await createTouchPage(browser, viewport);
    const failures = collectBrowserFailures(page);

    await page.goto(`${FIELD_URL}/report?offline=1`, { waitUntil: "domcontentloaded" });
    await page.getByRole("radio", { name: /Knee/ }).tap();
    await page.getByRole("radio", { name: "Impassable" }).tap();
    await page.getByRole("button", { name: /Save report offline/ }).tap();
    await expect(page).toHaveURL(/\/queue$/);
    await expect(page.getByRole("region", { name: "Waiting to submit" })).toBeVisible();

    const remove = page.getByRole("button", { name: "Remove" });
    await remove.evaluate((element) => element.scrollIntoView({ block: "center" }));
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toMatch(/Remove this unsent report and its evidence/i);
      await dialog.accept();
    });
    await remove.tap();
    await expect(page.getByText("No reports waiting")).toBeVisible();

    await page.goto(`${FIELD_URL}/lower-risk-route?offline=1`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Fresh route guidance unavailable offline")).toBeVisible();
    await expect(page.getByText(/must not be treated as safe/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Review .* to / })).toHaveCount(0);
    await expectResponsiveLayout(page, "390x844 offline lower-risk route");

    await page.goto(`${FIELD_URL}/report?offline=0`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Submit report/ }).tap();
    await expect(page).toHaveURL(/\/receipt\//);
    await expect(page.getByRole("heading", { name: "Report received" })).toBeVisible();
    await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
    await expectResponsiveLayout(page, "390x844 report receipt");

    expect(failures).toEqual([]);
    await context.close();
  });
});
