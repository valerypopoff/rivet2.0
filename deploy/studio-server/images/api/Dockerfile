# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS esbuild-security
ARG TARGETARCH
COPY deploy/studio-server/images/lib/rebuild-esbuild.sh /rebuild-esbuild.sh
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build sh /rebuild-esbuild.sh "$TARGETARCH"

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS builder

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

RUN apk add --no-cache git && \
    corepack enable && \
    corepack prepare pnpm@10.34.8 --activate

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
RUN YARN_NODE_LINKER=node-modules yarn build:runtime && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet2-evaluations run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-shared run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-bootstrap run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-executor run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-api run build
RUN mkdir /runtime && node deploy/studio-server/images/lib/prepare-runtime-packages.mjs /runtime/packages api
RUN node deploy/studio-server/images/lib/remove-dependency-test-fixtures.mjs /app/node_modules
COPY --from=esbuild-security /out/@esbuild /app/node_modules/@esbuild
COPY --from=esbuild-security /out/esbuild /app/node_modules/esbuild/bin/esbuild

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
COPY deploy/studio-server/images/lib/harden-package-manager-caches.mjs /opt/rivet/harden-package-manager-caches.mjs

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

RUN apk add --no-cache git && \
    npm install -g npm@11.21.1 pnpm@10.34.8 && \
    npm install --prefix /tmp/rivet-npm-security --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact undici@6.29.1 && \
    rm -rf /usr/local/lib/node_modules/npm/node_modules/undici && \
    mv /tmp/rivet-npm-security/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici && \
    rm -rf /tmp/rivet-npm-security /root/.npm && \
    node /opt/rivet/harden-package-manager-caches.mjs npm pnpm && \
    addgroup -g 10001 -S rivet && \
    adduser -u 10001 -S -D -h /home/rivet -G rivet rivet && \
    mkdir -p /workspace /workflows /data/rivet-app/plugins /data/rivet-app/logs /data/runtime-libraries /home/rivet/.local/share/com.valerypopoff.rivet2/plugins /opt/rivet/lib /app && \
    chown -R 10001:10001 /workspace /workflows /data /home/rivet /opt/rivet /app

WORKDIR /app/packages/studio-server-api

COPY --from=builder --chown=10001:10001 /app/node_modules /app/node_modules
COPY --from=builder --chown=10001:10001 /runtime/packages /app/packages
COPY --from=builder --chown=10001:10001 /app/packages/studio-server-executor/dist/executor-bundle.cjs /app/executor-bundle.cjs
COPY --chown=10001:10001 deploy/studio-server/images/lib/load-env.sh /opt/rivet/lib/load-env.sh
COPY --chown=10001:10001 deploy/studio-server/images/lib/bootstrap-deployment-storage-settings.mjs /opt/rivet/lib/bootstrap-deployment-storage-settings.mjs
COPY --chown=10001:10001 deploy/studio-server/images/api/entrypoint.sh /opt/rivet/api-entrypoint.sh
COPY --chown=10001:10001 deploy/studio-server/images/executor/entrypoint.sh /opt/rivet/executor-entrypoint.sh
COPY --chown=10001:10001 deploy/studio-server/images/api/backend-supervisor.mjs /opt/rivet/backend-supervisor.mjs
COPY --chown=10001:10001 deploy/studio-server/images/api/backend-retirement.mjs /opt/rivet/backend-retirement.mjs
COPY --chown=10001:10001 deploy/studio-server/images/api/housekeeping-supervisor.mjs deploy/studio-server/images/api/maintenance-lock.mjs deploy/studio-server/images/api/maintenance-lock-inherit.mjs /opt/rivet/
COPY --chown=10001:10001 deploy/studio-server/images/api/retire-backend.mjs /opt/rivet/retire-backend.mjs
COPY --chown=10001:10001 deploy/studio-server/images/api/local-upgrade-ui.mjs /opt/rivet/local-upgrade-ui.mjs
COPY --chown=10001:10001 deploy/studio-server/images/api/local-metadata-owner-lease.mjs /opt/rivet/local-metadata-owner-lease.mjs
COPY --chown=10001:10001 deploy/studio-server/scripts/lib/execution-autoscaler*.mjs deploy/studio-server/scripts/lib/release-operation-journal.mjs /app/packages/studio-server-api/autoscaler/

RUN chmod +x /opt/rivet/lib/load-env.sh /opt/rivet/api-entrypoint.sh /opt/rivet/executor-entrypoint.sh

ENV HOME=/home/rivet
ENV TMPDIR=/tmp
ENV npm_config_cache=/tmp/npm-cache
ENV XDG_CACHE_HOME=/tmp/cache
ENV PORT=8080
ENV RIVET_WORKSPACE_ROOT=/workspace
ENV RIVET_WORKFLOWS_ROOT=/workflows
ENV RIVET_APP_DATA_ROOT=/data/rivet-app
ENV RIVET_RUNTIME_LIBRARIES_ROOT=/data/runtime-libraries
ENV RIVET_RUNTIME_PROCESS_ROLE=api
ENV RIVET_RUNTIME_CONFIG_PROTOCOL=1

EXPOSE 8080
USER 10001:10001
RUN --mount=type=bind,source=deploy/studio-server/images/lib/verify-runtime-dependencies.mjs,target=/tmp/verify-runtime-dependencies.mjs,readonly \
    node /tmp/verify-runtime-dependencies.mjs npm pnpm

ENTRYPOINT ["/opt/rivet/api-entrypoint.sh"]
