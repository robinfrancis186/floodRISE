import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_HEADER,
  CloudCredentialUnavailableError,
  cloudFetch,
  configureCloudSecurity,
  FIREBASE_APP_CHECK_HEADER,
} from "./cloud-security";
import {
  apiIdentityForRole,
  submitApprovalDecision,
} from "./api";

function response(status = 200) {
  return new Response(null, { status });
}

function headersAt(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return new Headers(fetchMock.mock.calls[call]?.[1]?.headers as HeadersInit);
}

afterEach(() => {
  configureCloudSecurity(null);
  vi.unstubAllGlobals();
});

describe("operations cloud security", () => {
  it("does not add App Check in the deterministic demo configuration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await cloudFetch("/api/v1/incidents", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    expect(headersAt(fetchMock).has(FIREBASE_APP_CHECK_HEADER)).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
  });

  it("adds both live tokens, preserves idempotency, and removes demo identity", async () => {
    configureCloudSecurity({
      appCheck: { getToken: vi.fn().mockResolvedValue("header.payload.signature") },
      bearer: { getToken: vi.fn().mockResolvedValue("staff.payload.signature") },
    });
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await cloudFetch("/api/v1/approvals/a-1/decisions", {
      method: "POST",
      credentials: "include",
      headers: {
        "Idempotency-Key": "approval-command-1",
        "X-Demo-Role": "verifier",
      },
    });

    const headers = headersAt(fetchMock);
    expect(headers.get(FIREBASE_APP_CHECK_HEADER)).toBe("header.payload.signature");
    expect(headers.get(AUTHORIZATION_HEADER)).toBe("Bearer staff.payload.signature");
    expect(headers.get("Idempotency-Key")).toBe("approval-command-1");
    expect(headers.has("X-Demo-Role")).toBe(false);
  });

  it("protects an approval command through the operations API integration", async () => {
    configureCloudSecurity({
      appCheck: { getToken: vi.fn().mockResolvedValue("approval.header.signature") },
      bearer: { getToken: vi.fn().mockResolvedValue("staff.header.signature") },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      approval: {
        id: "approval-1",
        status: "APPROVED",
        version: 2,
      },
      alert: null,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await submitApprovalDecision(
      "approval-1",
      "APPROVE",
      "Independent review complete",
      1,
      apiIdentityForRole("Verifier"),
    );

    const headers = headersAt(fetchMock);
    expect(headers.get(FIREBASE_APP_CHECK_HEADER)).toBe("approval.header.signature");
    expect(headers.get(AUTHORIZATION_HEADER)).toBe("Bearer staff.header.signature");
    expect(headers.get("Idempotency-Key")).toBeTruthy();
    expect(headers.has("X-Demo-Role")).toBe(false);
    expect(headers.has("X-Demo-User")).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
  });

  it("rejects empty and control-character tokens before fetch without exposing them", async () => {
    const unsafeToken = "unsafe-token\r\nX-Injected: value";
    configureCloudSecurity({
      appCheck: { getToken: vi.fn().mockResolvedValue(unsafeToken) },
      bearer: { getToken: vi.fn().mockResolvedValue("staff-token") },
    });
    const fetchMock = vi.fn().mockResolvedValue(response(403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudFetch("/api/v1/incidents"))
      .rejects.toBeInstanceOf(CloudCredentialUnavailableError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(unsafeToken);
  });

  it("does not send a live request when either required token is unavailable", async () => {
    configureCloudSecurity({
      appCheck: { getToken: vi.fn().mockResolvedValue("app-check-token") },
      bearer: { getToken: vi.fn().mockResolvedValue(null) },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudFetch("/api/v1/auth/me"))
      .rejects.toBeInstanceOf(CloudCredentialUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a rejected read once but never loops", async () => {
    const tokenProvider = {
      getToken: vi.fn()
        .mockResolvedValueOnce("old.header.signature")
        .mockResolvedValueOnce("fresh.header.signature"),
    };
    configureCloudSecurity({
      appCheck: tokenProvider,
      bearer: { getToken: vi.fn().mockResolvedValue("staff-token") },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(403))
      .mockResolvedValueOnce(response(403));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cloudFetch("/api/v1/incidents", {
      credentials: "include",
    });

    expect(result.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenProvider.getToken.mock.calls).toEqual([[false], [true]]);
    expect(headersAt(fetchMock, 1).get(FIREBASE_APP_CHECK_HEADER))
      .toBe("fresh.header.signature");
  });

  it("refreshes the staff bearer credential once on a safe read", async () => {
    const bearerProvider = {
      getToken: vi.fn()
        .mockResolvedValueOnce("old.staff.signature")
        .mockResolvedValueOnce("fresh.staff.signature"),
    };
    configureCloudSecurity({
      appCheck: { getToken: vi.fn().mockResolvedValue("app-check-token") },
      bearer: bearerProvider,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cloudFetch("/api/v1/incidents", {
      credentials: "include",
      headers: {
        "X-Demo-Role": "incident_commander",
        "X-Demo-User": "ops-incident-commander",
      },
    });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerProvider.getToken.mock.calls).toEqual([[false], [true]]);
    expect(headersAt(fetchMock, 0).get(AUTHORIZATION_HEADER))
      .toBe("Bearer old.staff.signature");
    expect(headersAt(fetchMock, 1).get(AUTHORIZATION_HEADER))
      .toBe("Bearer fresh.staff.signature");
    expect(headersAt(fetchMock, 1).has("X-Demo-Role")).toBe(false);
    expect(headersAt(fetchMock, 1).has("X-Demo-User")).toBe(false);
  });

  it("does not replay a rejected request when credential refresh fails", async () => {
    const appCheckProvider = {
      getToken: vi.fn()
        .mockResolvedValueOnce("old.app-check.signature")
        .mockResolvedValueOnce(null),
    };
    const bearerProvider = {
      getToken: vi.fn()
        .mockResolvedValueOnce("old.staff.signature")
        .mockResolvedValueOnce("fresh.staff.signature"),
    };
    configureCloudSecurity({
      appCheck: appCheckProvider,
      bearer: bearerProvider,
    });
    const fetchMock = vi.fn().mockResolvedValue(response(401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloudFetch("/api/v1/incidents"))
      .rejects.toBeInstanceOf(CloudCredentialUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(appCheckProvider.getToken.mock.calls).toEqual([[false], [true]]);
    expect(bearerProvider.getToken.mock.calls).toEqual([[false], [true]]);
  });

  it("does not retry an unkeyed operational mutation", async () => {
    const tokenProvider = {
      getToken: vi.fn().mockResolvedValue("old.header.signature"),
    };
    configureCloudSecurity({
      appCheck: tokenProvider,
      bearer: { getToken: vi.fn().mockResolvedValue("staff-token") },
    });
    const fetchMock = vi.fn().mockResolvedValue(response(401));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cloudFetch("/api/v1/shelters/s-1", {
      method: "PATCH",
      credentials: "include",
      body: "{\"status\":\"OPEN\"}",
    });

    expect(result.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenProvider.getToken).toHaveBeenCalledTimes(1);
  });
});
