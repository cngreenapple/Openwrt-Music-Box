FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    OWRTMB_PORT=2030 \
    OWRTMB_HOST=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3-dev \
    libffi-dev \
    mpv \
    ffmpeg \
    bluez \
    bluez-alsa-utils \
    alsa-utils \
    psmisc \
    bash \
    socat \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x *.sh && mkdir -p /app/uploads

EXPOSE ${OWRTMB_PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request, os; port=os.environ.get('OWRTMB_PORT','2030'); urllib.request.urlopen(f'http://localhost:{port}/status')" || exit 1

CMD ["python", "app.py"]