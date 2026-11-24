FROM --platform=$BUILDPLATFORM node:22.22.3-bookworm-slim AS web

WORKDIR /web
COPY web ./

ARG VERSION=development
ENV VERSION=$VERSION
RUN npm ci --no-audit --no-fund \
 && node -e "const fs=require('fs');const f='public/version.json';const j=JSON.parse(fs.readFileSync(f,'utf8'));const v=process.env.VERSION||'development';j.version=v.replace(/^v/i,'');j.style=/-beta/i.test(v)?'beta':'stable';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');" \
 && npm run build \
 && test -f dist/index.html

FROM --platform=$BUILDPLATFORM golang:1.27.4-bookworm AS build

WORKDIR /src

# Cross-compile from the native build platform instead of running the Go
# toolchain under QEMU for linux/arm64. TARGETOS/TARGETARCH are injected by
# buildx; a plain `docker build` leaves them at the build platform defaults.
ARG TARGETOS=linux
ARG TARGETARCH
ENV GOOS=$TARGETOS \
    GOARCH=$TARGETARCH

# GOTOOLCHAIN=local makes the build fail instead of silently downloading the
# toolchain declared in go.mod. The image tag above already matches it.
ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=readonly

# Dependency layer: only the module files, so a source edit does not re-download.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Only the packages the binaries import. The web app itself is copied in from the
# web stage above; docs and tests never enter this layer.
COPY cmd ./cmd
COPY internal ./internal
COPY --from=web /web/dist ./internal/web/dist

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/practacu-press ./cmd/server \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/migrate ./cmd/migrate \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/seed ./cmd/seed \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/backup ./cmd/backup \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/media-gc ./cmd/media-gc \
 && go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/searchindex ./cmd/searchindex

# Stay on the stable Alpine branch and pull only the patched musl from edge:
# Alpine 3.24 still ships musl 1.2.6-r3 (CVE-2026-107891), while 1.2.6-r6 is
# available from edge. The upgrade below also picks up patched zlib 1.4-r0 and
# openssl 3.5.9-r1 from the 3.24 repository.
FROM alpine:3.24 AS runtime

ARG EDGE_REPO=https://dl-cdn.alpinelinux.org/alpine/edge/main

# ca-certificates is required for SMTP, OAuth, captcha and S3 over TLS; tzdata
# keeps timestamps readable for operators who set TZ. Upgrade the stable branch
# first, then replace only musl/musl-utils with the fixed edge packages.
RUN apk upgrade --no-cache \
 && apk add --no-cache --repository="$EDGE_REPO" \
        musl=1.2.6-r6 musl-utils=1.2.6-r6 \
 && apk add --no-cache ca-certificates tzdata \
 && addgroup --gid 10001 practacu \
 && adduser --uid 10001 --ingroup practacu --disabled-password --no-create-home \
        --shell /sbin/nologin practacu \
 && mkdir -p /data \
 && chown 10001:10001 /data

COPY --from=build /out/ /usr/local/bin/

USER 10001:10001
WORKDIR /data

# The container listens on all interfaces; PP_ALLOW_REMOTE_API is what lets the
# process accept that instead of insisting on loopback.
ENV HTTP_ADDR=0.0.0.0:8080 \
    PP_ALLOW_REMOTE_API=1 \
    DATABASE_DRIVER=sqlite \
    DATABASE_DSN=file:/data/practacu.db \
    STORAGE_DRIVER=local \
    STORAGE_DIR=/data/media \
    BACKUP_DIR=/data/backups

EXPOSE 8080
STOPSIGNAL SIGTERM

# wget is BusyBox's, already present in the base image.
HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=5 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

# Subcommands are available for `docker compose exec practacu-press <command>`.
CMD ["practacu-press"]
