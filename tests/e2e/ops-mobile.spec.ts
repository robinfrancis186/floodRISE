import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const routes = [
  { name: "Live Map", path: "/" },
  { name: "FloodSignal", path: "/signals" },
  { name: "Incidents", path: "/incidents" },
  { name: "Evacuation", path: "/evacuation" },
  { name: "Shelters", path: "/shelters" },
  { name: "Resilience Audit", path: "/resilience" },
  { name: "Source Health", path: "/sources" },
  { name: "Audit Log", path: "/audit" },
] as const;

const viewports = [
  { name: "320x568", width: 320, height: 568 },
  { name: "360x800", width: 360, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "844x390", width: 844, height: 390 },
] as const;

async function expectContainedShell(page: Page) {
  const layout = await page.evaluate(() => {
    const app = document.querySelector(".app-frame")?.getBoundingClientRect();
    const banner = document.querySelector(".app-frame > [role='status']:first-child") as HTMLElement | null;
    const bannerRect = banner?.getBoundingClientRect();
    const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
    const main = document.querySelector(".main-region")?.getBoundingClientRect();
    const nav = document.querySelector(".sidebar")?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      app: app && { top: app.top, bottom: app.bottom },
      banner: bannerRect && {
        top: bannerRect.top,
        bottom: bannerRect.bottom,
        clientHeight: banner?.clientHeight ?? 0,
        scrollHeight: banner?.scrollHeight ?? 0,
      },
      topbar: topbar && { top: topbar.top },
      main: main && { top: main.top, bottom: main.bottom, height: main.height },
      nav: nav && { top: nav.top, bottom: nav.bottom, height: nav.height },
    };
  });

  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.app).not.toBeNull();
  expect(layout.app!.top).toBeGreaterThanOrEqual(-1);
  expect(layout.app!.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.banner!.top).toBeGreaterThanOrEqual(0);
  expect(layout.banner!.bottom).toBeLessThanOrEqual(layout.topbar!.top + 1);
  expect(layout.banner!.scrollHeight).toBeLessThanOrEqual(layout.banner!.clientHeight + 1);
  expect(layout.main!.top).toBeGreaterThanOrEqual(0);
  expect(layout.main!.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.main!.height).toBeGreaterThan(0);
  expect(layout.nav!.top).toBeGreaterThanOrEqual(0);
  expect(layout.nav!.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
}

async function expectMobileTouchTargets(page: Page) {
  const undersized = await page.evaluate(() => {
    const selectors = [
      ".main-region button",
      ".main-region select",
      ".main-region input:not([type='checkbox']):not([type='radio'])",
      ".main-region textarea",
      ".role-select select",
      ".sidebar .nav-item",
      ".sidebar-demo button",
      ".decision-dialog button",
      ".decision-dialog select",
      ".decision-dialog input:not([type='checkbox']):not([type='radio'])",
      ".decision-dialog textarea",
    ].join(",");
    return [...document.querySelectorAll<HTMLElement>(selectors)].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const rendered = style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
      if (!rendered || (rect.width >= 43.5 && rect.height >= 43.5)) return [];
      return [{
        label: element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        className: element.className,
      }];
    });
  });
  expect(undersized, "rendered Operations controls must retain a 44 px mobile hit area").toEqual([]);
}

async function expectSeparatedOverlays(page: Page, firstSelector: string, secondSelector: string) {
  const overlapArea = await page.evaluate(({ firstSelector, secondSelector }) => {
    const first = document.querySelector(firstSelector)?.getBoundingClientRect();
    const second = document.querySelector(secondSelector)?.getBoundingClientRect();
    if (!first || !second || first.width === 0 || second.width === 0) return 0;
    const width = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
    const height = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
    return width * height;
  }, { firstSelector, secondSelector });
  expect(overlapArea, `${firstSelector} must not cover ${secondSelector}`).toBe(0);
}

async function waitForMap(page: Page) {
  const loading = page.getByText("Loading the detailed Kerala map…");
  if (await loading.count()) {
    await loading.first().waitFor({ state: "hidden", timeout: 8_000 }).catch(() => undefined);
  }
}

test.describe("Operations mobile compatibility", () => {
  test.describe.configure({ mode: "serial" });

  for (const viewport of viewports) {
    test(`${viewport.name} keeps every route contained, reachable, and touch sized`, async ({ browser, request }, testInfo) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      const runtimeErrors: string[] = [];
      page.on("pageerror", (error) => runtimeErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") runtimeErrors.push(message.text());
      });
      const reset = await request.post("http://127.0.0.1:8787/api/v1/demo/reset", {
        headers: {
          "X-Demo-Role": "identity_administrator",
          "X-Demo-User": `ops-mobile-${viewport.name}`,
          "Idempotency-Key": `ops-mobile-${viewport.name}`,
        },
      });
      expect(reset.ok()).toBeTruthy();

      for (const route of routes) {
        await page.goto(`http://127.0.0.1:55173${route.path}`, { waitUntil: "domcontentloaded" });
        await expect(page).toHaveTitle(/floodRISE Operations/);
        const activeNavigation = page.getByRole("button", { name: route.name });
        await expect(activeNavigation).toHaveAttribute("aria-current", "page");
        await expect.poll(async () => {
          const navigationBox = await page.getByRole("complementary", { name: "Primary navigation" }).boundingBox();
          const activeBox = await activeNavigation.boundingBox();
          return Boolean(
            navigationBox
            && activeBox
            && activeBox.x >= navigationBox.x - 1
            && activeBox.x + activeBox.width <= navigationBox.x + navigationBox.width + 1,
          );
        }).toBe(true);
        await expect(page.getByText(/DEMO DATA.*NOT LIVE/).first()).toBeVisible();
        await waitForMap(page);
        await expectContainedShell(page);
        await expectMobileTouchTargets(page);

        if (route.name === "Source Health") {
          await expect(page.getByRole("region", { name: "Operational source health table" })).toHaveAttribute("tabindex", "0");
        }
        if (route.name === "Audit Log") {
          await expect(page.getByRole("region", { name: "Audit event table" })).toHaveAttribute("tabindex", "0");
        }
        if (route.name === "Evacuation") {
          await expect(page.locator(".route-option").first()).toBeAttached();
          await expect(page.getByText(/Valid until .* IST/).first()).toBeVisible();
        }
        if (route.name === "Resilience Audit") {
          const toggle = page.getByRole("button", { name: "Map filters" });
          await expectSeparatedOverlays(page, ".audit-controls-toggle", ".fr-map-demo-label");
          await toggle.tap();
          await expect(page.locator("#resilience-map-controls")).toBeVisible();
          const layerLabels = page.locator(".audit-controls fieldset label");
          for (let index = 0; index < await layerLabels.count(); index += 1) {
            expect((await layerLabels.nth(index).boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
          }
          await page.getByRole("button", { name: "Hide map filters" }).tap();
          const workspace = page.locator(".resilience-workspace");
          const initialScrollTop = await workspace.evaluate((element) => element.scrollTop);
          await page.locator(".resilience-map .fr-map-canvas").hover();
          await page.mouse.wheel(0, 260);
          await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScrollTop);
        }
        if (route.name === "Live Map" || route.name === "Evacuation") {
          await expectSeparatedOverlays(page, ".fr-map-legend", ".fr-map-demo-label");
        }
        if (route.name === "FloodSignal") {
          await expectSeparatedOverlays(page, ".map-layer-key", ".fr-map-demo-label");
        }
        if (route.name === "Live Map" && viewport.height > 500) {
          await expect(page.locator(".status-rail .status-item:visible")).toHaveCount(3);
        }

        const screenshotRoute = (viewport.name === "320x568" && route.name === "FloodSignal")
          || (viewport.name === "390x844" && route.name === "Evacuation")
          || (viewport.name === "768x1024" && route.name === "Shelters")
          || (viewport.name === "844x390" && route.name === "Live Map");
        if (screenshotRoute) {
          if (route.name === "FloodSignal") await page.locator(".cluster-row").first().scrollIntoViewIfNeeded();
          if (route.name === "Evacuation") await page.locator(".route-list-panel").scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-${route.name.toLowerCase().replaceAll(" ", "-")}.png`) });
        }
      }

      await page.goto("http://127.0.0.1:55173/", { waitUntil: "domcontentloaded" });
      const synchronizedSummary = page.getByRole("region", { name: "Synchronized map feature summary" });
      await expect(synchronizedSummary).toBeVisible();
      const firstSummaryFeature = synchronizedSummary.getByRole("button").first();
      await firstSummaryFeature.tap();
      await expect(firstSummaryFeature).toHaveAttribute("aria-pressed", "true");
      await expectMobileTouchTargets(page);

      await page.goto("http://127.0.0.1:55173/signals", { waitUntil: "domcontentloaded" });
      const verify = page.getByRole("button", { name: /Verify flooding/i });
      await verify.click();
      const dialog = page.getByRole("dialog", { name: "Verify community corroboration" });
      await expect(dialog).toBeVisible();
      const dialogBox = (await dialog.boundingBox())!;
      expect(dialogBox.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox.y).toBeGreaterThanOrEqual(0);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width);
      expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height);
      await expectMobileTouchTargets(page);
      if (viewport.name === "320x568" || viewport.name === "844x390") {
        await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-dialog.png`) });
      }
      await dialog.getByRole("button", { name: "Close decision dialog" }).click();

      const navigation = page.getByRole("complementary", { name: "Primary navigation" });
      await navigation.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      const sourcesButton = navigation.getByRole("button", { name: "Source Health" });
      await sourcesButton.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/sources$/);
      await navigation.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await navigation.getByRole("button", { name: "Audit Log" }).click();
      await expect(page).toHaveURL(/\/audit$/);
      const advanceReplay = navigation.getByRole("button", { name: "Advance 10 min" });
      await advanceReplay.tap();
      await expect(page.getByText(/Authoritative estimates refreshed/i)).toBeVisible();
      await expect(navigation.getByRole("button", { name: "Reset replay" })).toBeDisabled();
      expect(runtimeErrors).toEqual([]);
      await context.close();
    });
  }

  test("390x844 source and audit tables pass mobile WCAG AA scanning", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    for (const route of ["/sources", "/audit"]) {
      await page.goto(`http://127.0.0.1:55173${route}`, { waitUntil: "domcontentloaded" });
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      const serious = results.violations
        .filter(({ impact }) => impact === "critical" || impact === "serious")
        .map(({ id, impact, nodes }) => ({
          id,
          impact,
          targets: nodes.map((node) => node.target),
        }));
      expect(serious, `${route} must not have serious mobile axe violations`).toEqual([]);
    }
    await context.close();
  });
});
