# Base image used for isolated per-execution containers.
# Keep it minimal and locked down.

FROM python:3.12-alpine

# Create non-root user
RUN addgroup -S sandbox && adduser -S -G sandbox sandbox

# A writable working directory when combined with `--tmpfs /tmp` and bind-mounts.
WORKDIR /sandbox

# Avoid Python writing .pyc files into the mount.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Root filesystem will be set to read-only at runtime via `--read-only`.
# We rely on `--tmpfs /tmp` for temp writes.

USER sandbox

# Default command can be overridden by `docker run ... python /sandbox/main.py`
CMD ["python", "/sandbox/main.py"]
