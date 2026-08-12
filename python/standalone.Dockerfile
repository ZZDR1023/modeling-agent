# Build context: exported project root
FROM python:3.11.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/modeling-project/reproducibility/python \
    HOME=/tmp

WORKDIR /opt/modeling-project
COPY reproducibility/environment/requirements.lock reproducibility/environment/requirements.lock
RUN python -m pip install --no-cache-dir --requirement reproducibility/environment/requirements.lock

COPY reproducibility/python/modeling_agent reproducibility/python/modeling_agent
COPY reproduce.py reproduce.py
COPY deliverables deliverables
COPY reproducibility/inputs reproducibility/inputs
COPY reproducibility/experiments reproducibility/experiments
COPY reproducibility/problem-spec.json reproducibility/problem-spec.json
COPY reproducibility/reproduce.json reproducibility/reproduce.json
COPY reproducibility/package-manifest.json reproducibility/package-manifest.json

RUN chown 65532:65532 /opt/modeling-project
USER 65532:65532
ENTRYPOINT []
CMD ["python", "reproduce.py"]
