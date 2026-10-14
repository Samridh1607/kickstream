# One image: the pipeline serves the API and the built web app, and records the program
# picture with Chromium and ffmpeg. Build from the repository root:
#   docker build -f deploy/docker/Dockerfile .

FROM node:24-bookworm-slim AS web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @kickstream/web...
COPY apps/web apps/web
RUN pnpm --filter @kickstream/web build

FROM python:3.13-slim-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium ffmpeg fonts-noto-core fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.13 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY services/pipeline/pyproject.toml services/pipeline/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/pipeline/kickstream ./kickstream
RUN uv sync --frozen --no-dev

COPY --from=web /src/apps/web/dist /app/web
COPY deploy/docker/chromium-capture.sh /usr/local/bin/chromium-capture
RUN chmod 0755 /usr/local/bin/chromium-capture

# Root, so the mounted Azure Files share (owned by root) is writable.
ENV PATH="/app/.venv/bin:$PATH" \
    KICKSTREAM_DATA_DIR=/data \
    KICKSTREAM_CACHE_DIR=/data/cache \
    KICKSTREAM_WEB_DIR=/app/web \
    KICKSTREAM_PROGRAM_URL=http://127.0.0.1:8000/studio?output \
    KICKSTREAM_BROWSER=/usr/local/bin/chromium-capture
EXPOSE 8000
CMD ["uvicorn", "kickstream.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
