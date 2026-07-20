import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./generated/schema";

export type { components, operations, paths } from "./generated/schema";

export interface FloodRiseClientOptions extends Omit<ClientOptions, "baseUrl"> {
  baseUrl?: string;
}

/** Create a fully typed client from the committed floodRISE OpenAPI contract. */
export function createFloodRiseClient(options: FloodRiseClientOptions = {}) {
  // FastAPI emits absolute versioned paths (for example `/api/v1/reports`).
  // The default therefore targets the current origin without duplicating the
  // prefix; deployments may pass an API origin such as https://api.example.in.
  const { baseUrl = "", ...clientOptions } = options;
  return createClient<paths>({ baseUrl, ...clientOptions });
}

export type FloodRiseApiClient = ReturnType<typeof createFloodRiseClient>;
