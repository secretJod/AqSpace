# Lecture Notes AI (Flask notes worker). Binds 127.0.0.1:${LNA_PORT:-5055} by design;
# aq-api joins this container's network namespace (network_mode: service:notes-ai).
FROM python:3.12-slim

ENV PYTHONUTF8=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LNA_PORT=5055 \
    LNAI_BROWSER=/usr/local/bin/chromium-nosandbox

# Headless Chromium for PDF rendering, ffmpeg for caption-less videos.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ffmpeg fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Chrome running as root in a container needs --no-sandbox; /dev/shm is small in Docker.
RUN printf '#!/bin/sh\nexec chromium --no-sandbox --disable-dev-shm-usage "$@"\n' > /usr/local/bin/chromium-nosandbox \
 && chmod +x /usr/local/bin/chromium-nosandbox

WORKDIR /app
COPY . /app
RUN pip install ".[web]"

WORKDIR /app/backend
EXPOSE 5055
CMD ["python", "run.py"]
