FROM python:3.10-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /opt/ytb-vps-v2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgl1 libglib2.0-0 \
    && ffmpeg -h full 2>&1 | grep -q -- "-fps_mode" \
    && rm -rf /var/lib/apt/lists/*

COPY containers/ocr-v2/requirements.txt /tmp/ocr-v2-requirements.txt
RUN python -m pip install --no-cache-dir -r /tmp/ocr-v2-requirements.txt

COPY pyproject.toml ./
COPY src ./src
COPY containers/ocr-v2/worker.py /app/worker.py
COPY containers/ocr-v2/provider_smoke.py /app/provider_smoke.py
COPY containers/ocr-v2/entrypoint.sh /usr/local/bin/ytb-vps-v2-ocr

RUN python -m pip install --no-cache-dir --no-deps -e . \
    && chmod 0555 /usr/local/bin/ytb-vps-v2-ocr

WORKDIR /app
ENTRYPOINT ["ytb-vps-v2-ocr"]
