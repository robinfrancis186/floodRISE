import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoRoutes } from "../data/demo";
import { AlertsPage } from "./AlertsPage";
import { LowerRiskRoutePage } from "./LowerRiskRoutePage";
import { ReportFloodingPage } from "./ReportFloodingPage";

const {
  fetchAlertsMock,
  fetchRoutesMock,
  navigateMock,
  saveReceiptMock,
  submitReportMock,
} = vi.hoisted(() => ({
  fetchAlertsMock: vi.fn(),
  fetchRoutesMock: vi.fn(),
  navigateMock: vi.fn(),
  saveReceiptMock: vi.fn(),
  submitReportMock: vi.fn(),
}));

vi.mock("@floodrise/map", () => ({
  FloodMap: ({ ariaLabel }: { ariaLabel?: string }) => (
    <div aria-label={ariaLabel}>Detailed Kerala map</div>
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
  fetchAlertsMock.mockResolvedValue([]);
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
  saveReceiptMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("field location safety policy", () => {
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
});

describe("field alert empty state", () => {
  it("announces when no current caution or alert is in force", async () => {
    renderWithQuery(<AlertsPage />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      /No current alerts for the demo scenario time/i,
    );
  });
});
