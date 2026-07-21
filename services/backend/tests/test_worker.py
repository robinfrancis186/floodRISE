"""Worker configuration and deterministic task acceptance tests."""

import pytest

from app.config import Settings
from app.worker import create_celery_app


def test_demo_worker_is_eager_and_has_no_external_broker() -> None:
    application = create_celery_app(Settings(env="test", demo_mode=True, database_url="sqlite://"))

    assert application.conf.broker_url == "memory://"
    assert application.conf.task_always_eager is True
    assert application.conf.task_default_queue == "floodrise-jobs"
    assert application.conf.result_backend is None


def test_production_worker_uses_only_the_predefined_sqs_queue() -> None:
    queue_url = "https://sqs.ap-south-1.amazonaws.com/123456789012/floodrise-production-jobs"
    application = create_celery_app(
        Settings(
            env="production",
            demo_mode=False,
            database_url="postgresql+psycopg://example.invalid/floodrise",
            oidc_issuer="https://identity.example.test/pool",
            oidc_jwks_url="https://identity.example.test/pool/.well-known/jwks.json",
            session_secret="test-production-session-secret",
            jobs_queue_url=queue_url,
            jobs_queue_name="floodrise-production-jobs",
        )
    )

    assert application.conf.broker_url == "sqs://"
    assert application.conf.task_always_eager is False
    assert application.conf.task_default_queue == "floodrise-production-jobs"
    assert application.conf.broker_transport_options == {
        "predefined_queues": {
            "floodrise-production-jobs": {"url": queue_url},
        },
        "visibility_timeout": 900,
        "polling_interval": 1,
    }


def test_production_worker_fails_closed_without_an_https_queue() -> None:
    settings = Settings(
        env="production",
        demo_mode=False,
        database_url="postgresql+psycopg://example.invalid/floodrise",
        oidc_issuer="https://identity.example.test/pool",
        oidc_jwks_url="https://identity.example.test/pool/.well-known/jwks.json",
        session_secret="test-production-session-secret",
    )
    with pytest.raises(RuntimeError, match="required outside demo mode"):
        create_celery_app(settings)

    with pytest.raises(RuntimeError, match="must be an HTTPS SQS queue URL"):
        create_celery_app(settings.model_copy(update={"jobs_queue_url": "http://queue"}))
