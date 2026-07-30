import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFieldDatabaseForTests,
  enqueueReport,
  fieldDb,
  type OfflineReportDraft
} from "../lib/db";
import { OfflineQueuePage } from "./OfflineQueuePage";

vi.mock("../hooks/useNetworkStatus", () => ({
  useNetworkStatus: () => ({
    browserOnline: false,
    isForcedOffline: false,
    isOfflineOnly: true,
    isOnline: false
  })
}));

function draft(id: string, place: string): OfflineReportDraft {
  return {
    client_report_id: id,
    incident_id: "inc-demo-kerala-flood-2023",
    reporter_id: "reporter-a",
    device_id: "device-a",
    observed_at: "2023-12-04T08:39:00.000Z",
    location: { latitude: 10.1041, longitude: 76.3519, accuracy_m: 12 },
    water_depth: "KNEE",
    road_status: "DIFFICULT",
    infrastructure_issues: ["BLOCKED_DRAIN"],
    place_label: place
  };
}

describe("offline queue damaged-record recovery", () => {
  beforeEach(async () => {
    await clearFieldDatabaseForTests();
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await fieldDb.close();
  });

  it("keeps healthy reports visible and lets the reporter remove only an unreadable draft", async () => {
    const healthy = await enqueueReport(
      draft("healthy-report-client-0001", "Healthy report"),
      Date.now()
    );
    const damaged = await enqueueReport(
      draft("damaged-report-client-0001", "Secret damaged place"),
      Date.now() + 1
    );
    await fieldDb.queue.update(damaged.id, { ciphertext: "not-valid-base64!" });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const user = userEvent.setup();
    render(<OfflineQueuePage />);

    expect(await screen.findByText("Healthy report")).toBeVisible();
    expect(screen.getByText("Encrypted draft unavailable")).toBeVisible();
    expect(screen.queryByText("Secret damaged place")).not.toBeInTheDocument();
    expect(screen.getByText(/No encrypted evidence is displayed/u)).toBeVisible();

    const damagedItem = screen.getByText("Encrypted draft unavailable").closest("li");
    expect(damagedItem).not.toBeNull();
    await user.click(
      screen.getAllByRole("button", { name: "Remove" }).find(
        (button) => damagedItem?.contains(button)
      )!
    );

    await waitFor(() => {
      expect(screen.queryByText("Encrypted draft unavailable")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Healthy report")).toBeVisible();
    await expect(fieldDb.queue.get(damaged.id)).resolves.toBeUndefined();
    await expect(fieldDb.queue.get(healthy.id)).resolves.toBeDefined();
  });
});
