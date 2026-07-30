import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_SCENARIO_TIME, demoAlerts, demoRoutes } from "../data/demo";
import { AlertsPage } from "./AlertsPage";
import { LowerRiskRoutePage } from "./LowerRiskRoutePage";
import { ReportFloodingPage } from "./ReportFloodingPage";

const {
  enqueueReportMock,
  fetchAlertsMock,
  fetchRoutesMock,
  navigateMock,
  rememberReceiptForSessionMock,
  saveReceiptMock,
  submitReportMock,
} = vi.hoisted(() => ({
  enqueueReportMock: vi.fn(),
  fetchAlertsMock: vi.fn(),
  fetchRoutesMock: vi.fn(),
  navigateMock: vi.fn(),
  rememberReceiptForSessionMock: vi.fn(),
  saveReceiptMock: vi.fn(),
  submitReportMock: vi.fn(),
}));

vi.mock("@floodrise/map", () => ({
  FloodMap: ({
    ariaLabel,
    showRouteGeometry,
  }: {
    ariaLabel?: string;
    showRouteGeometry?: boolean;
  }) => (
    <div
      aria-label={ariaLabel}
      data-route-geometry={showRouteGeometry ? "visible" : "hidden"}
    >
      Detailed Kerala map
    </div>
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../hooks/useNetworkStatus", () => ({
  useNetworkStatus: () => ({ isOnline: true, isForcedOffline: false }),
}));

vi.mock("../hooks/useQueueSummary", () => ({
  useQueueSummary: () => ({ count: 0, totalBytes: 0, loading: false }),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return {
    ...original,
    fetchAlerts: fetchAlertsMock,
    fetchRoutes: fetchRoutesMock,
    submitReport: submitReportMock,
  };
});

vi.mock("../lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/db")>();
  return {
    ...original,
    enqueueReport: enqueueReportMock,
    rememberReceiptForSession: rememberReceiptForSessionMock,
    saveReceipt: saveReceiptMock,
  };
});

function renderWithQuery(child: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={client}>{child}</QueryClientProvider>);
}

function mockGeolocation(accuracy: number) {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (
        success: PositionCallback,
      ) => success({
        coords: {
          accuracy,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          latitude: 10.111,
          longitude: 76.36,
          speed: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition),
    },
  });
}

beforeEach(() => {
  fetchAlertsMock.mockResolvedValue({
    items: [],
    source: "API",
    referenceTime: DEMO_SCENARIO_TIME,
    message: "Current alerts loaded from the incident API.",
  });
  fetchRoutesMock.mockResolvedValue({
    alternatives: demoRoutes,
    availability: "CURRENT",
    source: "API",
    referenceTime: "2023-12-04T14:10:00.000Z",
    message: "Current guidance.",
  });
  submitReportMock.mockResolvedValue({
    id: "report-authoritative-1",
    clientReportId: "client-report-1",
    reference: "report-authoritative-1",
    receivedAt: "2023-12-04T14:10:00.000Z",
    placeLabel: "Current location",
    status: "RECEIVED",
    source: "API",
    message: "Report received.",
  });
  navigateMock.mockResolvedValue(undefined);
  enqueueReportMock.mockResolvedValue(undefined);
  saveReceiptMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("field location safety policy", () => {
  it("preserves the accepted client ID and receipt when local receipt persistence fails", async () => {
    const user = userEvent.setup();
    saveReceiptMock.mockRejectedValueOnce(
      new DOMException("Receipt quota reached", "QuotaExceededError"),
    );
    renderWithQuery(<ReportFloodingPage />);

    await user.click(screen.getByRole("button", { name: /Submit report/i }));

    await waitFor(() => expect(submitReportMock).toHaveBeenCalledTimes(1));
    const submittedDraft = submitReportMock.mock.calls[0]?.[0];
    expect(rememberReceiptForSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "report-authoritative-1" }),
    );
    expect(enqueueReportMock).toHaveBeenCalledWith(
      submittedDraft,
      expect.any(Number),
      expect.objectContaining({
        lastError: expect.stringMatching(/accepted by the API.*receipt storage will retry/i),
      }),
    );
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/receipt/$receiptId",
      params: { receiptId: "report-authoritative-1" },
    });
  });

  it("preserves an imprecise report reading and announces that it is ineligible for live corroboration", async () => {
    const user = userEvent.setup();
    mockGeolocation(247.4);
    renderWithQuery(<ReportFloodingPage />);

    await user.click(screen.getByRole("button", { name: /Adjust pin/i }));

    expect(screen.getByText("Location accuracy is too low for live corroboration").closest("[role=alert]")).toHaveTextContent(
      /247 m.*does not qualify for live community corroboration/i,
    );

    await user.click(screen.getByRole("button", { name: /Submit report/i }));
    await waitFor(() => expect(submitReportMock).toHaveBeenCalledTimes(1));
    expect(submitReportMock.mock.calls[0]?.[0]).toMatchObject({
      location: {
        latitude: 10.111,
        longitude: 76.36,
        accuracy_m: 247.4,
      },
    });
  });

  it("clears displayed routes and makes no new request for a device fix worse than 100 metres", async () => {
    const user = userEvent.setup();
    mockGeolocation(180);
    renderWithQuery(<LowerRiskRoutePage />);

    expect(await screen.findByText(demoRoutes[0]!.label)).toBeInTheDocument();
    expect(fetchRoutesMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /Use current/i }));

    expect(screen.getByText("Location accuracy is too low for route guidance").closest("[role=alert]")).toHaveTextContent(
      /180 m.*route guidance requires 100 m or better/i,
    );
    expect(screen.queryByText(demoRoutes[0]!.label)).not.toBeInTheDocument();
    expect(fetchRoutesMock).toHaveBeenCalledTimes(1);
  });

  it("requests fresh guidance with the unmodified accuracy for an eligible device fix", async () => {
    const user = userEvent.setup();
    mockGeolocation(42.7);
    renderWithQuery(<LowerRiskRoutePage />);
    await screen.findByText(demoRoutes[0]!.label);

    await user.click(screen.getByRole("button", { name: /Use current/i }));

    await waitFor(() => expect(fetchRoutesMock).toHaveBeenCalledTimes(2));
    expect(fetchRoutesMock.mock.calls[1]?.[0]).toMatchObject({
      latitude: 10.111,
      longitude: 76.36,
      accuracy_m: 42.7,
    });
  });

  it("selects one route for review and updates the announced route details", async () => {
    const user = userEvent.setup();
    renderWithQuery(<LowerRiskRoutePage />);

    const firstRoute = demoRoutes[0]!;
    const secondRoute = demoRoutes[1]!;
    const firstReview = await screen.findByRole("button", {
      name: `Review ${firstRoute.label} to ${firstRoute.shelter}`,
    });
    const secondReview = screen.getByRole("button", {
      name: `Review ${secondRoute.label} to ${secondRoute.shelter}`,
    });

    expect(firstReview).toHaveAttribute("aria-pressed", "false");
    expect(secondReview).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("status", { name: "Selected route details" })).not.toBeInTheDocument();

    await user.click(secondReview);

    expect(firstReview).toHaveAttribute("aria-pressed", "false");
    expect(secondReview).toHaveAttribute("aria-pressed", "true");
    expect(secondReview).toHaveTextContent("Selected for review");
    expect(screen.getByRole("status", { name: "Selected route details" })).toHaveTextContent(
      `${secondRoute.duration_min} min · ${secondRoute.distance_km.toFixed(1)} km to ${secondRoute.shelter}`,
    );
    expect(screen.getByRole("status", { name: "Selected route details" })).toHaveTextContent(
      secondRoute.model_version,
    );
    expect(screen.getByRole("status", { name: "Selected route details" })).toHaveTextContent(
      secondRoute.evidence_version,
    );

    await user.click(firstReview);

    expect(firstReview).toHaveAttribute("aria-pressed", "true");
    expect(secondReview).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status", { name: "Selected route details" })).toHaveTextContent(
      `${firstRoute.duration_min} min · ${firstRoute.distance_km.toFixed(1)} km to ${firstRoute.shelter}`,
    );

    await user.click(firstReview);

    expect(firstReview).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("status", { name: "Selected route details" })).not.toBeInTheDocument();
  });

  it("withholds packaged route geometry when the API returns no current route", async () => {
    fetchRoutesMock.mockResolvedValueOnce({
      alternatives: [],
      availability: "UNAVAILABLE",
      source: "API",
      referenceTime: "2023-12-04T14:10:00.000Z",
      message: "No compliant route exists. Await responder guidance.",
    });
    renderWithQuery(<LowerRiskRoutePage />);

    expect(await screen.findByText("No compliant route exists. Await responder guidance.")).toBeInTheDocument();
    const contextMap = screen.getByLabelText(
      /Non-navigational demo context map showing flood estimates, road risk, and nearby shelters/i,
    );

    expect(contextMap).toHaveAttribute("data-route-geometry", "hidden");
    expect(screen.queryByLabelText(/Map of lower-risk route alternatives/i)).not.toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Route map safety boundary" })).toHaveTextContent(
      /Context only.*Route geometry is not provided by the recommendation API and is not shown/i,
    );
    expect(screen.queryByRole("button", { name: /Review .* to /i })).not.toBeInTheDocument();
  });
});

describe("field alert empty state", () => {
  it("announces when no current caution or alert is in force", async () => {
    renderWithQuery(<AlertsPage />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      /No current alerts for the demo scenario time/i,
    );
  });

  it("visibly discloses deterministic fallback data when the online alert API fails", async () => {
    fetchAlertsMock.mockResolvedValueOnce({
      items: demoAlerts,
      source: "DEMO_FALLBACK",
      referenceTime: DEMO_SCENARIO_TIME,
      message:
        "The alert API could not be reached. Showing deterministic DEMO DATA for the scenario checkpoint; this is not a current alert feed.",
    });
    renderWithQuery(<AlertsPage />);

    expect(await screen.findByText("Alert API unavailable")).toBeInTheDocument();
    expect(screen.getByText("Alert API unavailable").closest("[role=alert]")).toHaveTextContent(
      /deterministic DEMO DATA.*not a current alert feed/i,
    );
    expect(screen.getByText(demoAlerts[0]!.title)).toBeInTheDocument();
  });

  it("derives official demo and official labels from each alert's simulation metadata", async () => {
    const officialBase = {
      kind: "OFFICIAL" as const,
      description: "Follow instructions from authorized emergency officials.",
      area: "Periyar basin",
      issuedAt: "2023-12-04T13:50:00.000Z",
      validUntil: "2023-12-04T15:10:00.000Z",
      severity: "DANGER" as const,
    };
    fetchAlertsMock.mockResolvedValueOnce({
      items: [
        {
          ...officialBase,
          id: "official-demo",
          title: "Official simulated warning",
          isSimulated: true,
        },
        {
          ...officialBase,
          id: "official-live",
          title: "Official authority warning",
          isSimulated: false,
        },
      ],
      source: "API",
      referenceTime: DEMO_SCENARIO_TIME,
      message: "Current alerts loaded from the incident API.",
    });
    renderWithQuery(<AlertsPage />);

    expect(await screen.findByText("Official simulated warning")).toBeInTheDocument();
    expect(screen.getByText("Official demo")).toBeInTheDocument();
    expect(screen.getByText("Official", { exact: true })).toBeInTheDocument();
  });
});
