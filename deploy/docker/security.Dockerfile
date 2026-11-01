# syntax=docker/dockerfile:1
# Rust 安全服务镜像。构建上下文是仓库根目录：
#   docker build -f deploy/docker/security.Dockerfile .
#
# build.rs 用 protoc-bin-vendored 自带的 protoc 编译 proto，
# 因此构建阶段不需要在镜像里额外安装 protoc。

FROM rust:1-bookworm AS build
WORKDIR /src

# build.rs 期望的目录关系是 services/security ← ../../packages/contracts
COPY services/security ./services/security
COPY packages/contracts ./packages/contracts

WORKDIR /src/services/security
RUN cargo build --release --locked


FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates bash \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10002 --create-home --shell /usr/sbin/nologin practacu

COPY --from=build /src/services/security/target/release/practacu-security /usr/local/bin/practacu-security

USER practacu

# 容器内监听所有网卡；端口只在 compose 的内部网络里可达。
ENV SECURITY_GRPC_BIND=0.0.0.0:9001

EXPOSE 9001

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/9001' || exit 1

ENTRYPOINT ["/usr/local/bin/practacu-security"]
