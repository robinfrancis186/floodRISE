FROM ghcr.io/astral-sh/uv:0.8.22 AS uv

FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/floodrise-venv

COPY --from=uv /uv /uvx /bin/

RUN groupadd --system floodrise && useradd --system --gid floodrise --home /app floodrise

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini

RUN uv sync --frozen --no-dev && chown -R floodrise:floodrise /app /opt/floodrise-venv

USER floodrise
EXPOSE 8787

CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787"]
