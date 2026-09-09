FROM node:24-slim
ARG VERSION=development
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Steno Personal Updater" \
      org.opencontainers.image.description="Optional local Docker companion for owner-initiated Steno Personal upgrades" \
      org.opencontainers.image.source="https://github.com/0xmythril/steno-personal" \
      org.opencontainers.image.url="https://github.com/0xmythril/steno-personal" \
      org.opencontainers.image.documentation="https://github.com/0xmythril/steno-personal/blob/main/docs/upgrades.md" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && apt-get purge -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /updater
COPY updater/ ./
CMD ["node", "server.mjs"]
