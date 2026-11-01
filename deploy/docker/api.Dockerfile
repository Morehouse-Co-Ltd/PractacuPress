# syntax=docker/dockerfile:1
# Go API 镜像。构建上下文是仓库根目录：
#   docker build -f deploy/docker/api.Dockerfile .
#
# 纯静态二进制：SQLite 走 modernc.org/sqlite（纯 Go），所以 CGO 关闭也能用。

FROM golang:1.26-bookworm AS build
WORKDIR /src

# 先只拷依赖清单，让 go mod download 的层可以复用。
COPY go.mod go.sum ./
RUN go mod download

COPY . .

ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags "-s -w" -o /out/api ./apps/api/cmd/server \
 && go build -trimpath -ldflags "-s -w" -o /out/migrate ./apps/api/cmd/migrate \
 && go build -trimpath -ldflags "-s -w" -o /out/seed ./apps/api/cmd/seed


FROM debian:bookworm-slim AS runtime

# curl 只用于 HEALTHCHECK；其余包一律不装。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin practacu \
 && mkdir -p /data \
 && chown -R practacu:practacu /data

COPY --from=build /out/ /usr/local/bin/

USER practacu
WORKDIR /data

# 容器里必须监听 0.0.0.0，并由 PP_ALLOW_REMOTE_API 显式放行（默认只允许回环）。
ENV HTTP_ADDR=0.0.0.0:8080 \
    PP_ALLOW_REMOTE_API=1 \
    DATABASE_DRIVER=sqlite \
    DATABASE_DSN=file:/data/practacu.db \
    STORAGE_DRIVER=local \
    STORAGE_DIR=/data/media \
    SECURITY_GRPC_ADDR=security:9001

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

# 传参可执行迁移与种子命令：docker compose exec api migrate / seed
CMD ["api"]
