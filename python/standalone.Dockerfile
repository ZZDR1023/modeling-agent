# Build context: exported project root
FROM python:3.11.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/modeling-project/reproducibility/python \
    HOME=/tmp

WORKDIR /opt/modeling-project
COPY reproducibility/environment/requirements.lock reproducibility/environment/requirements.lock
RUN python -m pip install --no-cache-dir --requirement reproducibility/environment/requirements.lock

COPY . .

RUN chown 65532:65532 /opt/modeling-project
USER 65532:65532
ENTRYPOINT []
CMD ["python", "reproduce.py"]
