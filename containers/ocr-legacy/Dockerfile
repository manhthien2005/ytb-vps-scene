FROM paddlepaddle/paddle:2.4.2-gpu-cuda10.2-cudnn7.6-trt7.0

ARG MINICONDA_VERSION=py38_23.3.1-0
ARG MINICONDA_SHA256=d1f3a4388c1a6fd065e32870f67abc39eb38f4edd36c4947ec7411e32311bd59

ENV PATH=/opt/conda/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    FLAGS_allocator_strategy=auto_growth

RUN wget -q "https://repo.anaconda.com/miniconda/Miniconda3-${MINICONDA_VERSION}-Linux-x86_64.sh" -O /tmp/miniconda.sh \
    && echo "${MINICONDA_SHA256}  /tmp/miniconda.sh" | sha256sum -c - \
    && bash /tmp/miniconda.sh -b -p /opt/conda \
    && rm -f /tmp/miniconda.sh \
    && /opt/conda/bin/conda clean -afy

COPY requirements.txt /tmp/requirements.txt

RUN python -m pip install --no-cache-dir --upgrade "pip<25" \
    && python -m pip download --no-cache-dir --no-index --no-deps \
       --dest /tmp/paddle-noavx paddlepaddle-gpu==2.4.2 \
       -f https://www.paddlepaddle.org.cn/whl/linux/mkl/noavx/stable.html \
    && python -m pip install --no-cache-dir /tmp/paddle-noavx/*.whl \
    && python -m pip install --no-cache-dir -r /tmp/requirements.txt \
    && python -m pip uninstall -y opencv-python opencv-contrib-python opencv-python-headless \
    && python -m pip install --no-cache-dir opencv-python-headless==4.6.0.66 \
    && rm -rf /tmp/requirements.txt /tmp/paddle-noavx

COPY worker.py smoke.py /app/
WORKDIR /app

ENTRYPOINT ["python", "/app/worker.py"]
