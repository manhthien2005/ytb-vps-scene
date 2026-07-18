FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1

WORKDIR /opt/ytb-vps-v2
COPY pyproject.toml ./
COPY src ./src
COPY containers/ocr-v2/worker.py /app/worker.py

RUN python -m pip install --no-cache-dir --no-deps -e .

WORKDIR /app
ENTRYPOINT ["python", "/app/worker.py"]
