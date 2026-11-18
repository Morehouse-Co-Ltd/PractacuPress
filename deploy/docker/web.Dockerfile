# Static frontend image. Node only exists in the build stage; the runtime is the
# Nginx image with the compiled assets and the same-origin proxy config.
#   docker build -f deploy/docker/web.Dockerfile .

FROM --platform=$BUILDPLATFORM node:22.22.3-bookworm-slim AS build

WORKDIR /web

# npm is the canonical package manager (CI and the Windows packager use it). The
# lockfile is copied alone first so dependency installation is cached.
COPY apps/web/package.json apps/web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY apps/web ./

# Release builds pass the tag so the footer/update screen report the actual
# release instead of the repository's development version.
ARG VERSION=development
ENV VERSION=$VERSION
RUN node -e "const fs=require('fs');const f='public/version.json';const j=JSON.parse(fs.readFileSync(f,'utf8'));const v=process.env.VERSION||'development';j.version=v.replace(/^v/i,'');j.style=/-beta/i.test(v)?'beta':'stable';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');"

ENV NODE_ENV=production
RUN npm run build \
 && test -f dist/index.html


FROM nginx:1.29.8-alpine AS runtime

RUN rm -f /etc/nginx/conf.d/default.conf

# proxy-params.inc is included by locations; it must not live in conf.d, whose
# *.conf files Nginx includes at http level.
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/docker/proxy-params.inc /etc/nginx/proxy-params.inc
COPY --from=build /web/dist /usr/share/nginx/html

EXPOSE 80
# SIGQUIT drains in-flight requests instead of the fast shutdown SIGTERM asks for.
STOPSIGNAL SIGQUIT

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
