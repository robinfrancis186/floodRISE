FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/workspace/services/backend/.venv/bin:$PATH"

WORKDIR /workspace
COPY services/backend /workspace/services/backend
COPY fixtures /workspace/fixtures

RUN uv sync --project /workspace/services/backend --frozen --no-dev --no-editable \
    && useradd --system --uid 10001 floodrise \
    && chown -R floodrise:floodrise /workspace

USER floodrise
WORKDIR /workspace/services/backend
EXPOSE 8787

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787", "--timeout-graceful-shutdown", "30"]
