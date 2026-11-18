# Rust security service image. Build from the repository root:
#   docker build -f deploy/docker/security.Dockerfile .
#
# build.rs compiles packages/contracts/security/v1/security.proto with the
# protoc binary bundled by the protoc-bin-vendored crate, so no system protoc is
# required. The source tree relationship matters: build.rs resolves the proto as
# ../../packages/... relative to services/security.

FROM --platform=$BUILDPLATFORM rust:1.100.0-bookworm AS build

WORKDIR /src

# Cross-compile the arm64 binary on the native build platform: running the whole
# Rust build under QEMU is several times slower. The runtime stage still runs its
# apt-get under emulation, which is cheap by comparison.
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        apt-get update \
     && apt-get install -y --no-install-recommends \
            gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
     && rm -rf /var/lib/apt/lists/* \
     && rustup target add aarch64-unknown-linux-gnu; \
    fi

COPY packages/contracts/security/v1 ./packages/contracts/security/v1
COPY services/security ./services/security

WORKDIR /src/services/security

# --locked makes a stale Cargo.lock a build error instead of silently resolving
# newer crates. The caches keep rebuilds fast without baking them into the image.
# The binary is copied out of the cache-mounted target directory inside the same
# RUN: cache mounts are not part of the layer, so a later COPY --from would not
# see a binary left there.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/services/security/target \
    set -e; \
    target_dir="target"; \
    target_arg=""; \
    if [ "$TARGETARCH" = "arm64" ]; then \
        target_dir="target/aarch64-unknown-linux-gnu"; \
        target_arg="--target aarch64-unknown-linux-gnu"; \
        export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc; \
    fi; \
    cargo build --release --locked $target_arg; \
    install -m 0755 "$target_dir/release/practacu-security" /usr/local/bin/practacu-security

FROM debian:bookworm-slim AS runtime

# netcat is only the health probe: the service is a gRPC listener with no HTTP
# endpoint. ca-certificates keeps a future TLS listener working.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates netcat-openbsd \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10002 practacu \
 && useradd --uid 10002 --gid practacu --no-create-home --shell /usr/sbin/nologin practacu

COPY --from=build /usr/local/bin/practacu-security /usr/local/bin/practacu-security

USER 10002:10002

# Listen on all interfaces: the port is only reachable on the compose network.
ENV SECURITY_GRPC_BIND=0.0.0.0:9001

EXPOSE 9001
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
    CMD ["nc", "-z", "127.0.0.1", "9001"]

ENTRYPOINT ["/usr/local/bin/practacu-security"]
