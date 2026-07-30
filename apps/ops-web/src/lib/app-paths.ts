import type { ViewId } from "./models";

export const pathByView: Record<ViewId, string> = {
  live: "/",
  signals: "/signals",
  incidents: "/incidents",
  evacuation: "/evacuation",
  shelters: "/shelters",
  resilience: "/resilience",
  sources: "/sources",
  audit: "/audit",
};

export function normalizeAppBase(base: string): string {
  if (!base || base === "/") return "";
  return `/${base.replace(/^\/+|\/+$/g, "")}`;
}

export function appPathForView(view: ViewId, base: string): string {
  const normalizedBase = normalizeAppBase(base);
  const routePath = pathByView[view];
  return routePath === "/" ? `${normalizedBase}/` : `${normalizedBase}${routePath}`;
}

export function viewFromAppPath(pathname: string, base: string): ViewId {
  const normalizedBase = normalizeAppBase(base);
  let routePath = pathname;

  if (normalizedBase) {
    if (pathname === normalizedBase || pathname === `${normalizedBase}/`) {
      routePath = "/";
    } else if (pathname.startsWith(`${normalizedBase}/`)) {
      routePath = pathname.slice(normalizedBase.length);
    }
  }

  return (Object.entries(pathByView).find(([, path]) => path === routePath)?.[0] as ViewId | undefined) ?? "live";
}
