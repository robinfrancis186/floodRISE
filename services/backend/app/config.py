"""Application settings loaded from ``FLOODRISE_*`` environment variables."""

from functools import lru_cache
from typing import Annotated, Literal, Self

from pydantic import BeforeValidator, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError


def _split_origins(value: object) -> object:
    """Accept either JSON arrays or the comma-separated value used in ``.env``."""
    if isinstance(value, str):
        return [origin.strip().rstrip("/") for origin in value.split(",") if origin.strip()]
    return value


OriginList = Annotated[list[str], NoDecode, BeforeValidator(_split_origins)]
StringList = Annotated[list[str], NoDecode, BeforeValidator(_split_origins)]
_ENCRYPTED_POSTGRES_SSL_MODES = frozenset({"require", "verify-ca", "verify-full"})


def _validate_live_database_target(
    database_url: str,
    database_allowed_host: str | None,
    *,
    label: str,
) -> None:
    """Bind a remote PostgreSQL URL to its approved host and encrypted transport."""

    try:
        parsed = make_url(database_url)
    except ArgumentError:
        raise ValueError(f"{label} database_url must be a valid PostgreSQL URL") from None
    if parsed.get_backend_name() != "postgresql":
        raise ValueError(f"{label} database_url must use PostgreSQL for a remote runtime")

    sslmode = parsed.query.get("sslmode")
    if not isinstance(sslmode, str) or sslmode.casefold() not in _ENCRYPTED_POSTGRES_SSL_MODES:
        raise ValueError(
            f"{label} database_url must enforce encrypted PostgreSQL transport with "
            "sslmode=require, verify-ca, or verify-full"
        )

    approved_host = (database_allowed_host or "").strip()
    if not approved_host:
        raise ValueError(f"{label} database_allowed_host is required for a remote runtime")
    parsed_host = parsed.host
    normalized_parsed_host = parsed_host.rstrip(".").casefold() if parsed_host else None
    normalized_approved_host = approved_host.rstrip(".").casefold()
    if normalized_parsed_host != normalized_approved_host:
        raise ValueError(f"{label} database_url must target the approved database host")


class Settings(BaseSettings):
    """Runtime configuration with safe, fully local demo defaults."""

    model_config = SettingsConfigDict(
        env_prefix="FLOODRISE_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "floodRISE API"
    env: Literal["demo", "development", "test", "staging", "production"] = "demo"
    api_prefix: str = "/api/v1"
    debug: bool = False

    database_url: str = "sqlite:///./floodrise.db"
    database_allowed_host: str | None = None
    redis_url: str = "redis://localhost:6379/0"
    allowed_origins: OriginList = Field(
        default_factory=lambda: [
            "http://localhost:4173",
            "http://localhost:4174",
            "http://localhost:5173",
            "http://localhost:5174",
        ]
    )

    demo_mode: bool = True
    demo_incident_id: str = "inc-demo-kerala-flood-2023"
    demo_alert_sink: str = "fake://notification-sink"
    scenario_clock_start: str = "2023-12-04T14:10:00Z"

    oidc_issuer: str | None = None
    oidc_audience: str = "floodrise-api"
    oidc_jwks_url: str | None = None
    oidc_jwks_json: SecretStr | None = None
    oidc_algorithms: StringList = Field(default_factory=lambda: ["RS256"])
    oidc_role_claims: StringList = Field(
        default_factory=lambda: ["cognito:groups", "roles", "custom:roles"]
    )
    oidc_mfa_amr_values: StringList = Field(
        default_factory=lambda: ["mfa", "otp", "totp", "webauthn", "fido", "fido2", "hwk"]
    )
    oidc_phishing_resistant_amr_values: StringList = Field(
        default_factory=lambda: ["webauthn", "fido", "fido2", "hwk"]
    )
    oidc_step_up_acr_values: StringList = Field(
        default_factory=lambda: ["aal2", "aal3", "urn:floodrise:loa:step-up"]
    )
    oidc_mfa_claim: str = "custom:mfa"
    oidc_phishing_resistant_claim: str = "custom:phishing_resistant"
    oidc_step_up_claim: str = "custom:step_up"
    oidc_install_id_claim: str = "custom:install_id"
    oidc_step_up_max_age_seconds: int = Field(default=300, ge=60, le=3_600)
    oidc_jwks_cache_seconds: int = Field(default=300, ge=30, le=86_400)
    oidc_http_timeout_seconds: float = Field(default=3.0, gt=0, le=15)
    session_secret: SecretStr = SecretStr("demo-only-change-before-production")
    secure_cookies: bool = False

    firebase_app_check_enabled: bool = False
    firebase_app_check_project_number: str | None = None
    firebase_app_check_app_ids: StringList = Field(default_factory=list)
    firebase_app_check_jwks_url: str = "https://firebaseappcheck.googleapis.com/v1/jwks"
    firebase_app_check_jwks_json: SecretStr | None = None
    firebase_app_check_algorithms: StringList = Field(default_factory=lambda: ["RS256"])
    firebase_app_check_jwks_cache_seconds: int = Field(default=300, ge=30, le=21_600)
    firebase_app_check_http_timeout_seconds: float = Field(default=3.0, gt=0, le=15)

    object_store_endpoint: str = "http://localhost:9000"
    object_store_bucket: str = "floodrise-demo"
    object_store_region: str = "ap-south-1"
    jobs_queue_url: str | None = None
    jobs_queue_name: str = "floodrise-jobs"
    worker_visibility_timeout_seconds: int = Field(default=900, ge=60, le=43_200)

    sse_replay_limit: int = Field(default=1_000, ge=10, le=10_000)
    sse_max_connections: int = Field(default=100, ge=1, le=10_000)
    sse_max_connections_per_principal: int = Field(default=3, ge=1, le=100)
    sse_poll_interval_seconds: float = Field(default=1.0, ge=0.1, le=30)
    report_queue_limit: int = Field(default=100, ge=1, le=1_000)
    report_max_age_minutes: int = Field(default=45, ge=1, le=24 * 60)
    report_future_skew_minutes: int = Field(default=5, ge=0, le=60)
    route_max_snap_distance_m: float = Field(default=500, ge=50, le=5_000)

    @property
    def is_demo(self) -> bool:
        return self.demo_mode or self.env == "demo"

    @property
    def allow_demo_headers(self) -> bool:
        """Keep the offline judging identity shim out of deployed environments."""

        return self.env in {"demo", "test"}

    @property
    def resolved_oidc_jwks_url(self) -> str | None:
        if self.oidc_jwks_url:
            return self.oidc_jwks_url.rstrip("/")
        if self.oidc_issuer:
            return f"{self.oidc_issuer.rstrip('/')}/.well-known/jwks.json"
        return None

    @model_validator(mode="after")
    def validate_security_profile(self) -> Self:
        if self.env in {"staging", "production"}:
            if self.demo_mode:
                raise ValueError("demo_mode must be false in staging and production")
            _validate_live_database_target(
                self.database_url,
                self.database_allowed_host,
                label="API",
            )
            if not self.oidc_issuer:
                raise ValueError("oidc_issuer is required in staging and production")
            if not self.oidc_audience.strip():
                raise ValueError("oidc_audience is required in staging and production")
            if not self.oidc_jwks_json and not self.resolved_oidc_jwks_url:
                raise ValueError("OIDC JWKS configuration is required in staging and production")
            if not self.oidc_issuer.startswith("https://"):
                raise ValueError("oidc_issuer must use HTTPS in staging and production")
            if self.resolved_oidc_jwks_url and not self.resolved_oidc_jwks_url.startswith(
                "https://"
            ):
                raise ValueError("oidc_jwks_url must use HTTPS in staging and production")
            if self.session_secret.get_secret_value() == "demo-only-change-before-production":
                raise ValueError("session_secret must be changed in staging and production")
        if not self.oidc_algorithms or any(
            algorithm.lower() == "none" for algorithm in self.oidc_algorithms
        ):
            raise ValueError("oidc_algorithms must contain at least one signed algorithm")
        if set(self.firebase_app_check_algorithms) != {"RS256"}:
            raise ValueError("firebase_app_check_algorithms must contain only RS256")
        if self.firebase_app_check_enabled:
            project_number = (self.firebase_app_check_project_number or "").strip()
            if not project_number or not project_number.isdecimal():
                raise ValueError(
                    "firebase_app_check_project_number must be a numeric Google Cloud "
                    "project number when App Check is enabled"
                )
            self.firebase_app_check_project_number = project_number
            if self.env in {"staging", "production"} and not self.firebase_app_check_app_ids:
                raise ValueError(
                    "firebase_app_check_app_ids is required in staging and production "
                    "when App Check is enabled"
                )
            if self.env in {"demo", "test"} and not self.firebase_app_check_jwks_json:
                raise ValueError("demo and test App Check verification requires a static JWKS")
            if (
                not self.firebase_app_check_jwks_json
                and not self.firebase_app_check_jwks_url.startswith("https://")
            ):
                raise ValueError("firebase_app_check_jwks_url must use HTTPS outside offline tests")
        return self

    @property
    def environment(self) -> str:
        """Compatibility name used by operational logs and seed tooling."""
        return self.env

    @property
    def cors_origins(self) -> list[str]:
        """Explicit middleware-facing alias for the configured origins."""
        return self.allowed_origins

    @property
    def api_v1_prefix(self) -> str:
        return self.api_prefix


class SimulationJobSettings(BaseSettings):
    """Minimal configuration for the isolated Cloud Run simulation workload.

    The job deliberately does not load API identity, App Check, cookie, or
    pseudonymization settings. Its database credential is independently
    provisioned and revocable.
    """

    model_config = SettingsConfigDict(
        env_prefix="FLOODRISE_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    env: Literal["demo", "development", "test", "staging", "production"] = "demo"
    database_url: str = "sqlite:///./floodrise-job.db"
    database_allowed_host: str | None = None
    demo_mode: bool = True
    demo_alert_sink: str = "fake://notification-sink"
    route_max_snap_distance_m: float = Field(default=500, ge=50, le=5_000)

    @property
    def is_demo(self) -> bool:
        return self.demo_mode or self.env == "demo"

    @model_validator(mode="after")
    def validate_job_profile(self) -> Self:
        if self.env in {"staging", "production"} and self.demo_mode:
            raise ValueError("demo_mode must be false in staging and production")
        if self.env in {"staging", "production"} or self.database_allowed_host is not None:
            _validate_live_database_target(
                self.database_url,
                self.database_allowed_host,
                label="simulation",
            )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return one immutable-by-convention settings instance per process."""
    return Settings()


@lru_cache(maxsize=1)
def get_simulation_job_settings() -> SimulationJobSettings:
    """Load only the credentials and controls required by a simulation job."""
    return SimulationJobSettings()


__all__ = [
    "OriginList",
    "Settings",
    "SimulationJobSettings",
    "StringList",
    "get_settings",
    "get_simulation_job_settings",
]
