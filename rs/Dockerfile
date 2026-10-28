# syntax=docker/dockerfile:1.7
#
# keep: one image, one process tree. Litestream runs the api (`-exec`), so
# replication starts before the app writes and stops after it exits.
# Build from the repo root:  docker build -f rs/Dockerfile .
# (fly.staging.toml does the same.)

ARG LITESTREAM_VERSION=0.5.17
# sha256 of litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz from the
# GitHub release. Bump both together.
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d

# ---- SPA ------------------------------------------------------------------
FROM node:24-trixie-slim AS web
WORKDIR /src
# pnpm at the version package.json pins (`packageManager`).
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
# Build-time settings: the SPA talks to the same origin, and reports
# errors to Sentry when a DSN is given (public by design: it only lets a
# client send events).
ARG VITE_SENTRY_DSN=""
ARG VITE_RELEASE=""
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN VITE_RELEASE=$VITE_RELEASE
RUN pnpm build

# ---- server ---------------------------------------------------------------
FROM rust:1.97-slim-trixie AS server
WORKDIR /src/rs
COPY rs/ ./
# `keep` (crates/cli) is built when the crate exists (F1 adds it).
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-target,target=/src/rs/target \
    set -eu; \
    pkgs="-p api -p seed"; \
    [ -d crates/cli ] && pkgs="$pkgs -p cli"; \
    cargo build --release --locked $pkgs; \
    mkdir /out; \
    for bin in api seed keep-snapshot keep; do \
      [ -f target/release/$bin ] && cp target/release/$bin /out/; \
    done; \
    ls -l /out

# ---- litestream -----------------------------------------------------------
FROM debian:trixie-slim AS litestream
ARG LITESTREAM_VERSION
ARG LITESTREAM_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    f=litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz; \
    curl -fsSLo /tmp/$f https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/$f; \
    echo "${LITESTREAM_SHA256}  /tmp/$f" | sha256sum -c -; \
    tar -xzf /tmp/$f -C /usr/local/bin litestream

# ---- runtime --------------------------------------------------------------
FROM debian:trixie-slim
# sqlite3: the entrypoint creates platform.db before Litestream starts, and
# the drill checks restored files with it.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=server /out/ /usr/local/bin/
COPY --from=web /src/dist /app/dist
COPY rs/litestream.yml /etc/litestream.yml
COPY scripts/ops/entrypoint.sh scripts/ops/restore.sh scripts/ops/drill.sh /usr/local/bin/
ENV KEEP_DATA_DIR=/data \
    KEEP_STATIC_DIR=/app/dist \
    KEEP_BIND=0.0.0.0 \
    KEEP_PORT=8080 \
    KEEP_LITESTREAM_SOCKET=/run/litestream.sock
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
