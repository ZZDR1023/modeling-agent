FROM python:3.11.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/modeling-agent

WORKDIR /opt/modeling-agent
COPY requirements.lock /opt/modeling-agent/requirements.lock
RUN python -m pip install --no-cache-dir --requirement /opt/modeling-agent/requirements.lock
COPY modeling_agent /opt/modeling-agent/modeling_agent

USER 65532:65532
ENTRYPOINT []
CMD ["python", "-m", "modeling_agent.runner", "--help"]
