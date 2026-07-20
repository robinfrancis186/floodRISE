# floodRISE generated API client

This package is generated from the running FastAPI `/api/v1/openapi.json`
contract and wraps it with `openapi-fetch` for end-to-end request and response
typing.

```bash
pnpm api:generate
pnpm api:check
```

The committed `openapi.json` and `src/generated/schema.ts` make contract checks
deterministic in CI without starting an external provider or production service.
