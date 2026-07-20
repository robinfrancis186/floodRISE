const DEVICE_ID_KEY = "floodrise.field.device-id";
const REPORTER_ID_KEY = "floodrise.field.reporter-id";

function persistentUuid(key: string, prefix: string) {
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const value = `${prefix}-${crypto.randomUUID()}`;
  localStorage.setItem(key, value);
  return value;
}

export function getDeviceId() {
  return persistentUuid(DEVICE_ID_KEY, "device");
}

export function getReporterId() {
  return persistentUuid(REPORTER_ID_KEY, "reporter");
}

export function createClientReportId() {
  return crypto.randomUUID();
}
