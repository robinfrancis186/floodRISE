"""Application settings loaded from ``FLOODRISE_*`` environment variables."""

from functools import lru_cache
from typing import Annotated, Literal, Self

from pydantic import BeforeValidator, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def _split_origins(value: object) -> object:
    """Accept either JSON arrays or the comma-separated value used in ``.env``."""
    if isinstance(value, str):
        return [origin.strip().rstrip("/") for origin in value.split(",") if origin.strip()]
    return value


OriginList = Annotated[list[str], NoDecode, BeforeValidator(_split_origins)]
StringList = Annotated[list[str], NoDecode, BeforeValidator(_split_origins)]


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
    demo_incident_id: str = "inc-demo-michaung-2023"
    demo_alert_sink: str = "fake://notification-sink"
    scenario_clock_start: str = "2023-12-04T14:10:00Z"

    # CAP 1.2 sender identity. A deploying authority replaces these with the
    # identifier it registered with its alert aggregator (e.g. NDMA SACHET).
    cap_sender: str = "demo@floodrise.invalid"
    cap_sender_name: str = "floodRISE deterministic demo (not an alerting authority)"

    oidc_issuer: str | None = None
    oidc_audience: str = "floodrise-api"
    oidc_jwks_url: str | None = None
    oidc_jwks_json: SecretStr | None = None
    oidc_algorithms: StringList = Field(default_factory=lambda: ["RS256"])
    oidc_role_claims: StringList = Field(
        default_factory=lambda: ["cognito:groups", "roles", "custom:roles", "realm_access.roles"]
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
    oidc_step_up_max_age_seconds: int = Field(default=300, ge=60, le=3_600)
    oidc_jwks_cache_seconds: int = Field(default=300, ge=30, le=86_400)
    oidc_http_timeout_seconds: float = Field(default=3.0, gt=0, le=15)
    session_secret: SecretStr = SecretStr("demo-only-change-before-production")
    secure_cookies: bool = False

    # Optional open-source ClamAV daemon. When unset, non-demo media stays
    # quarantined (fail closed) until a scanner is configured or injected.
    clamav_host: str | None = None
    clamav_port: int = Field(default=3310, ge=1, le=65_535)
    clamav_timeout_seconds: float = Field(default=10.0, gt=0, le=60)

    object_store_endpoint: str = "http://localhost:9000"
    object_store_bucket: str = "floodrise-demo"
    object_store_region: str = "ap-south-1"

    sse_replay_limit: int = Field(default=1_000, ge=10, le=10_000)
    report_queue_limit: int = Field(default=100, ge=1, le=1_000)
    report_max_age_minutes: int = Field(default=45, ge=1, le=24 * 60)
    report_future_skew_minutes: int = Field(default=5, ge=0, le=60)

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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return one immutable-by-convention settings instance per process."""
    return Settings()


settings = get_settings()


__all__ = ["OriginList", "Settings", "StringList", "get_settings", "settings"]
