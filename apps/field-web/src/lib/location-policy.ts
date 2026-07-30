export const MAX_LIVE_LOCATION_ACCURACY_M = 100;

export function isLiveEligibleLocationAccuracy(accuracyM: number) {
  return Number.isFinite(accuracyM)
    && accuracyM >= 0
    && accuracyM <= MAX_LIVE_LOCATION_ACCURACY_M;
}
