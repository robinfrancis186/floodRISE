"""Export the authoritative FastAPI contract for generated clients."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPOSITORY_ROOT / "services" / "backend"
OUTPUT = REPOSITORY_ROOT / "packages" / "api-client" / "openapi.json"

sys.path.insert(0, str(BACKEND_ROOT))

from app.main import app  # noqa: E402


def render_contract() -> str:
    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


def main() -> None:
    rendered = render_contract()
    if "--check" in sys.argv[1:]:
        current_paths = set(app.openapi().get("paths", {}))
        existing = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if existing != rendered:
            snapshot_paths = set(json.loads(existing).get("paths", {})) if existing else set()
            added = ", ".join(sorted(current_paths - snapshot_paths)) or "none"
            removed = ", ".join(sorted(snapshot_paths - current_paths)) or "none"
            raise SystemExit(
                "OpenAPI snapshot is stale. Run `pnpm api:generate`. "
                f"Added paths: {added}; removed paths: {removed}."
            )
        print(f"OpenAPI snapshot matches FastAPI ({len(current_paths)} paths).")
        return

    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"Exported FastAPI OpenAPI contract to {OUTPUT}.")


if __name__ == "__main__":
    main()
