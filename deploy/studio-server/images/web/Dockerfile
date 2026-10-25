# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS dependencies

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG all_proxy
ARG no_proxy

ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY
ENV ALL_PROXY=$ALL_PROXY
ENV NO_PROXY=$NO_PROXY
ENV http_proxy=$http_proxy
ENV https_proxy=$https_proxy
ENV all_proxy=$all_proxy
ENV no_proxy=$no_proxy

RUN corepack enable

WORKDIR /app
# Dependency inputs are stable across source-only changes. Keep every workspace
# manifest so Yarn resolves the same lockfile and workspace links as a full checkout.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY scripts/checks/check-package-manager.mjs ./scripts/checks/check-package-manager.mjs
COPY packages/app/package.json ./packages/app/package.json
COPY packages/app-executor/package.json ./packages/app-executor/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/docs/package.json ./packages/docs/package.json
COPY packages/evaluations/package.json ./packages/evaluations/package.json
COPY packages/node/package.json ./packages/node/package.json
COPY packages/studio-server-api/package.json ./packages/studio-server-api/package.json
COPY packages/studio-server-bootstrap/package.json ./packages/studio-server-bootstrap/package.json
COPY packages/studio-server-executor/package.json ./packages/studio-server-executor/package.json
COPY packages/studio-server-shared/package.json ./packages/studio-server-shared/package.json
COPY packages/studio-server-web/package.json ./packages/studio-server-web/package.json

RUN --mount=type=cache,target=/root/.cache/yarn \
    YARN_NODE_LINKER=node-modules YARN_CHECKSUM_BEHAVIOR=ignore yarn install --immutable
COPY packages ./packages
COPY scripts ./scripts
COPY deploy ./deploy
COPY tsconfig.base.json LICENSE README.md ./
RUN YARN_NODE_LINKER=node-modules yarn build:hosted-web-deps

# Development serves immutable watched bundles, not an unrestricted Vite source
# server. Dependencies remain Linux-owned; only selected source paths are bound.
FROM dependencies AS development
RUN addgroup -g 10001 -S rivet && \
    adduser -u 10001 -S -D -h /home/rivet -G rivet rivet && \
    mkdir -p /home/rivet/.cache /app/artifacts /opt/rivet && \
    mv /app/packages/studio-server-web/node_modules /opt/rivet/web-node-modules && \
    mkdir -p /app/packages/studio-server-web/node_modules && \
    chown -R 10001:10001 /home/rivet /app/artifacts
ENV HOME=/home/rivet
ENV RIVET_DEV_FRONTEND_MODE=tunnel
ENV RIVET_DEV_BUNDLE_ROOT=/home/rivet/.cache/bundles
ENV HOSTED_VITE_CACHE_DIR=/home/rivet/.cache/vite
ENV NODE_OPTIONS=--max-old-space-size=6144
WORKDIR /app/packages/studio-server-web
EXPOSE 5174
USER 10001:10001
CMD ["sh", "-ec", "cp -R /opt/rivet/web-node-modules/. ./node_modules/; exec node dev/tunnel.mjs"]

FROM dependencies AS builder
ARG VITE_RIVET_DEBUG_LOGS=false
ARG RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=/workflows
ARG RIVET_LATEST_WORKFLOWS_BASE_PATH=/workflows-latest
ARG RIVET_PUBLISHED_APPS_BASE_PATH=/apps
ARG RIVET_LATEST_APPS_BASE_PATH=/apps-latest
ARG RIVET_WEB_APPS_BASE_PATH=/apps
ARG RIVET_LATEST_WEB_APPS_BASE_PATH=/apps-latest
ARG RIVET_WEB_BUILD_MAX_OLD_SPACE_SIZE=4096
ENV VITE_RIVET_DEBUG_LOGS=$VITE_RIVET_DEBUG_LOGS
ENV RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=$RIVET_PUBLISHED_WORKFLOWS_BASE_PATH
ENV RIVET_LATEST_WORKFLOWS_BASE_PATH=$RIVET_LATEST_WORKFLOWS_BASE_PATH
ENV RIVET_PUBLISHED_APPS_BASE_PATH=$RIVET_PUBLISHED_APPS_BASE_PATH
ENV RIVET_LATEST_APPS_BASE_PATH=$RIVET_LATEST_APPS_BASE_PATH
ENV RIVET_WEB_APPS_BASE_PATH=$RIVET_WEB_APPS_BASE_PATH
ENV RIVET_LATEST_WEB_APPS_BASE_PATH=$RIVET_LATEST_WEB_APPS_BASE_PATH
RUN NODE_OPTIONS="--max-old-space-size=${RIVET_WEB_BUILD_MAX_OLD_SPACE_SIZE}" \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-web run build
RUN YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-api exec esbuild \
    ../studio-server-web/production/server.mjs --bundle --platform=node --format=esm --target=node20 \
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
    --outfile=/app/web-server.mjs

FROM --platform=$TARGETPLATFORM ${NODE_IMAGE}

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG all_proxy
ARG no_proxy

ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY
ENV ALL_PROXY=$ALL_PROXY
ENV NO_PROXY=$NO_PROXY
ENV http_proxy=$http_proxy
ENV https_proxy=$https_proxy
ENV all_proxy=$all_proxy
ENV no_proxy=$no_proxy

# The static server never installs packages at runtime. Do not ship the base
# image's unused package managers and their separate vulnerable dependency trees.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg && \
    addgroup -g 10001 -S rivet && \
    adduser -u 10001 -S -D -h /home/rivet -G rivet rivet && \
    mkdir -p /app && \
    chown -R 10001:10001 /app /home/rivet

WORKDIR /app
COPY --from=builder --chown=10001:10001 /app/packages/studio-server-web/dist /app/dist
COPY --from=builder --chown=10001:10001 /app/web-server.mjs /app/web-server.mjs

ENV HOME=/home/rivet
ENV TMPDIR=/tmp

EXPOSE 3000
USER 10001:10001

CMD ["node", "/app/web-server.mjs"]
