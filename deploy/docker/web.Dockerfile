# syntax=docker/dockerfile:1
# 前端镜像：Node 只出现在构建阶段，运行阶段是纯静态文件 + Nginx。
#   docker build -f deploy/docker/web.Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /web

# 锁定依赖版本，保证可复现构建。
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY apps/web ./
RUN npm run build


FROM nginx:1.27-alpine AS runtime

RUN rm /etc/nginx/conf.d/default.conf
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
