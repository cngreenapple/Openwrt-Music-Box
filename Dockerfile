# ========== STAGE 1: Builder ==========
FROM python:3.11-slim-bookworm AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ========== STAGE 2: Runtime ==========
FROM python:3.11-slim-bookworm AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    OWRTMB_PORT=2030 \
    OWRTMB_HOST=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    mpv \
    ffmpeg \
    bluez \
    bluez-alsa-utils \
    alsa-utils \
    psmisc \
    bash \
    socat \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    # yt-dlp: coba download binary dulu, fallback pip
    && { curl -sL --connect-timeout 10 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp 2>/dev/null \
         && chmod a+rx /usr/local/bin/yt-dlp \
         || echo "yt-dlp binary download failed, will use pip fallback"; } \
    && { command -v yt-dlp || pip install --no-cache-dir yt-dlp; } \
    && chmod a+rx /usr/local/bin/yt-dlp 2>/dev/null || true

WORKDIR /app

COPY --from=builder /install /usr/local

COPY . .
RUN chmod +x *.sh

# Buat folder uploads
RUN mkdir -p /app/uploads

EXPOSE ${OWRTMB_PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request, os; port=os.environ.get('OWRTMB_PORT','2030'); urllib.request.urlopen(f'http://localhost:{port}/status')" || exit 1

CMD ["python", "app.py"]