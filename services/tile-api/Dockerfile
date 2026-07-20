FROM python:3.13-slim
WORKDIR /app
COPY services/tile-api/pyproject.toml ./
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" pillow
COPY services/tile-api/app ./app
COPY fixtures/kerala-demo/rasters ./artifacts
USER 65532:65532
EXPOSE 8790
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8790"]
