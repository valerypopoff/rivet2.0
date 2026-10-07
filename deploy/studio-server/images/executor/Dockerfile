# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS builder

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
RUN YARN_NODE_LINKER=node-modules yarn build:runtime && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet2-evaluations run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-shared run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-bootstrap run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-executor run build
RUN mkdir /runtime && node deploy/studio-server/images/lib/prepare-runtime-packages.mjs /runtime/packages executor

FROM node:20-alpine

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

RUN addgroup -g 10001 -S rivet && \
    adduser -u 10001 -S -D -h /home/rivet -G rivet rivet && \
    mkdir -p /home/rivet/.local/share/com.valerypopoff.rivet2/plugins /data/runtime-libraries /opt/rivet/lib /app && \
    chown -R 10001:10001 /home/rivet /data /opt/rivet /app

WORKDIR /app

COPY --from=builder --chown=10001:10001 /app/node_modules /app/node_modules
COPY --from=builder --chown=10001:10001 /runtime/packages /app/packages
COPY --from=builder --chown=10001:10001 /app/packages/studio-server-executor/dist/executor-bundle.cjs /app/executor-bundle.cjs
COPY --chown=10001:10001 deploy/studio-server/images/lib/load-env.sh /opt/rivet/lib/load-env.sh
COPY --chown=10001:10001 deploy/studio-server/images/executor/entrypoint.sh /opt/rivet/executor-entrypoint.sh

RUN chmod +x /opt/rivet/lib/load-env.sh /opt/rivet/executor-entrypoint.sh

ENV HOME=/home/rivet
ENV RIVET_EXECUTOR_PORT=21889
ENV RIVET_EXECUTOR_HOST=0.0.0.0
ENV RIVET_RUNTIME_LIBRARIES_ROOT=/data/runtime-libraries
ENV RIVET_CODE_RUNNER_REQUIRE_ROOT=/data/runtime-libraries/current/node_modules
ENV RIVET_RUNTIME_PROCESS_ROLE=executor
ENV RIVET_RUNTIME_CONFIG_PROTOCOL=1

EXPOSE 21889
USER 10001:10001

ENTRYPOINT ["/opt/rivet/executor-entrypoint.sh"]
