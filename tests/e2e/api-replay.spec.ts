import { expect, test } from "@playwright/test";
import reports from "../../fixtures/kerala-demo/reports.json";

const apiUrl = "http://127.0.0.1:8787/api/v1";
const incidentId = "inc-demo-kerala-flood-2023";

test("four independent reports produce one explicitly unofficial corroboration", async ({ request }) => {
  expect((await request.post(`${apiUrl}/demo/reset`, {
    headers: {
      "X-Demo-Role": "identity_administrator",
      "X-Demo-User": "playwright-demo-reset",
    },
  })).ok()).toBeTruthy();
  expect((await request.post(`${apiUrl}/demo/advance`, {
    headers: {
      "X-Demo-Role": "engineer",
      "X-Demo-User": "playwright-demo-engineer",
    },
    data: { minutes: 10, run_simulation: false },
  })).ok()).toBeTruthy();

  const states: string[] = [];
  let fourthElapsedMs = 0;
  for (const [index, source] of reports.slice(0, 4).entries()) {
    const started = performance.now();
    const response = await request.post(`${apiUrl}/reports`, {
      headers: {
        "Idempotency-Key": `playwright-${source.client_report_id}`,
        "X-Demo-Role": "reporter",
        "X-Demo-User": `playwright-reporter-${index + 1}`,
      },
      data: {
        client_report_id: source.client_report_id,
        incident_id: incidentId,
        reporter_id: source.reporter_id,
        device_id: source.device_id,
        observed_at: source.observed_at,
        location: source.location,
        water_depth: source.water_depth,
        road_status: source.road_status,
        infrastructure_issues: [],
        note: "Deterministic Playwright evidence",
      },
    });
    if (index === 3) fourthElapsedMs = performance.now() - started;
    expect(response.status()).toBe(201);
    const payload = await response.json();
    states.push(payload.signal.state);
  }

  expect(states).toEqual(["CANDIDATE", "CORROBORATING", "CORROBORATING", "COMMUNITY_CORROBORATED"]);
  expect(fourthElapsedMs).toBeLessThan(5_000);

  const signals = await request.get(`${apiUrl}/signals`, { params: { incident_id: incidentId } });
  expect(signals.ok()).toBeTruthy();
  const signal = (await signals.json()).items[0];
  expect(signal).toMatchObject({
    state: "COMMUNITY_CORROBORATED",
    independent_report_count: 4,
    route_recalculation_requested: true,
    display_message: "Corroborated by 4 independent recent reports; not an official confirmation.",
  });

  const audit = await request.get(`${apiUrl}/audit`, {
    headers: { "X-Demo-Role": "auditor", "X-Demo-User": "playwright-auditor" },
  });
  expect(audit.ok()).toBeTruthy();
  expect((await audit.json()).chain_valid).toBe(true);
});
