import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiptPage } from "./ReceiptPage";

const {
  getReceiptMock,
  recoverAuthoritativeReceiptMock
} = vi.hoisted(() => ({
  getReceiptMock: vi.fn(),
  recoverAuthoritativeReceiptMock: vi.fn()
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
  useParams: () => ({ receiptId: "report-authoritative-1" })
}));

vi.mock("../lib/cloud-access", () => ({
  useFieldCloudAccess: () => ({
    mode: "full",
    runtime: {
      mode: "live",
      incidentId: "incident-live-1",
      referenceTime: "2026-07-30T10:00:00.000Z",
      incidentName: "Ernakulam response",
      areaName: "Ernakulam district",
      incidentStatus: "ACTIVE"
    }
  })
}));

vi.mock("../lib/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/db")>(),
  getReceipt: getReceiptMock
}));

vi.mock("../lib/receipt-recovery", () => ({
  recoverAuthoritativeReceipt: recoverAuthoritativeReceiptMock
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("receipt recovery screen", () => {
  it("uses the authenticated authoritative report when IndexedDB cannot be read", async () => {
    getReceiptMock.mockRejectedValue(new DOMException("IndexedDB unavailable"));
    recoverAuthoritativeReceiptMock.mockResolvedValue({
      id: "report-authoritative-1",
      clientReportId: "report-authoritative-1",
      reference: "report-authoritative-1",
      receivedAt: "2026-07-30T10:01:00.000Z",
      placeLabel: "Ernakulam district",
      status: "RECEIVED",
      source: "API",
      message: "Report received."
    });

    render(<ReceiptPage />);

    expect(await screen.findByRole("heading", { name: "Report received" })).toBeVisible();
    expect(screen.getByText("report-authoritative-1")).toBeVisible();
    expect(recoverAuthoritativeReceiptMock).toHaveBeenCalledWith(
      "report-authoritative-1",
      expect.objectContaining({
        mode: "live",
        incidentId: "incident-live-1"
      })
    );
  });
});
