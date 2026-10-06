import type { MessageKey } from "../lib/i18n";

export type Helpline = {
  id: string;
  number: string;
  labelKey: MessageKey;
  scope: "NATIONAL" | "STATE" | "DISTRICT" | "CITY";
};

// Packaged so the list is available with no network. Mirrors the backend
// registry at /api/v1/india/emergency-contacts for the Chennai demo region;
// every number must be verified by the deploying authority.
export const helplines: Helpline[] = [
  { id: "erss-112", number: "112", labelKey: "contact.erss-112", scope: "NATIONAL" },
  { id: "ndma-1078", number: "1078", labelKey: "contact.ndma-1078", scope: "NATIONAL" },
  { id: "state-1070", number: "1070", labelKey: "contact.state-1070", scope: "STATE" },
  { id: "gcc-1913", number: "1913", labelKey: "contact.gcc-1913", scope: "CITY" },
  { id: "district-1077", number: "1077", labelKey: "contact.district-1077", scope: "DISTRICT" },
  { id: "ambulance-108", number: "108", labelKey: "contact.ambulance-108", scope: "NATIONAL" },
  { id: "fire-101", number: "101", labelKey: "contact.fire-101", scope: "NATIONAL" },
  { id: "police-100", number: "100", labelKey: "contact.police-100", scope: "NATIONAL" },
  { id: "women-1091", number: "1091", labelKey: "contact.women-1091", scope: "NATIONAL" },
  { id: "child-1098", number: "1098", labelKey: "contact.child-1098", scope: "NATIONAL" }
];
