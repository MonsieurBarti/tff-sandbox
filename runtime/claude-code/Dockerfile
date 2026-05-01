# IMPORTANT: keep this Dockerfile context-free (no COPY/ADD).
# tff-sandbox runs `docker build -t <tag> -` with this file streamed via stdin
# and no build context. Adding COPY here will break the build silently.

FROM node:22-bookworm@sha256:9059d9d7db987b86299e052ff6630cd95e5a770336967c21110e53289a877433

RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Rename base "node" user (UID 1000) → "tff", make $HOME world-writable so the
# container is safe to run as --user $(id -u):$(id -g) when host UID differs from
# 1000 (e.g. macOS hosts where it's typically 501). 0777 is heavy-handed; see
# SPEC §Notes for the trade-off.
RUN usermod -d /home/tff -m -l tff node \
    && chmod 0777 /home/tff

USER tff

# Latest claude-code at image build time. Pinning revisited in S04 (where the
# CLI surface is consumed). The image-cache hash invalidates automatically when
# this line changes; see SPEC §Notes for the recipe-vs-image identity caveat.
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV HOME="/home/tff"
ENV PATH="/home/tff/.local/bin:$PATH"

WORKDIR /home/tff

# Long-lived container — orchestrator drives commands via `docker exec`.
ENTRYPOINT ["sleep", "infinity"]
