# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS builder

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

RUN apk add --no-cache git
RUN corepack enable && \
    corepack prepare pnpm@10.18.3 --activate

WORKDIR /app

COPY wrapper/bootstrap/proxy-bootstrap/ /opt/proxy-bootstrap/
RUN --mount=type=cache,target=/root/.npm npm --prefix /opt/proxy-bootstrap ci

COPY --from=rivet_dependency_metadata . rivet/
WORKDIR /app/rivet
RUN --mount=type=cache,target=/root/.cache/yarn YARN_NODE_LINKER=node-modules YARN_CHECKSUM_BEHAVIOR=ignore yarn install --immutable || YARN_NODE_LINKER=node-modules YARN_CHECKSUM_BEHAVIOR=ignore yarn install

COPY --from=rivet_source . /app/rivet/
WORKDIR /app/rivet
RUN YARN_NODE_LINKER=node-modules yarn build:runtime && \
    YARN_NODE_LINKER=node-modules yarn build:hosted-web-deps

WORKDIR /app
COPY wrapper/api/package.json wrapper/api/package-lock.json wrapper/api/

WORKDIR /app/wrapper/api
RUN --mount=type=cache,target=/root/.npm npm ci

WORKDIR /app
COPY scripts/link-rivet-node-package.mjs scripts/link-rivet-node-package.mjs
COPY scripts/lib/rivet-local-dependencies.mjs scripts/lib/rivet-local-dependencies.d.mts scripts/lib/
COPY wrapper/api/ wrapper/api/
COPY wrapper/shared/ wrapper/shared/

WORKDIR /app/wrapper/api
RUN node /app/scripts/link-rivet-node-package.mjs
RUN npm run build

FROM node:24-alpine

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
    corepack prepare pnpm@10.18.3 --activate && \
    addgroup -g 10001 -S rivet && \
    adduser -u 10001 -S -D -h /home/rivet -G rivet rivet && \
    mkdir -p /workspace /workflows /data/rivet-app/plugins /data/rivet-app/logs /data/runtime-libraries /home/rivet /opt/rivet/lib && \
    chown -R 10001:10001 /workspace /workflows /data /home/rivet /opt/rivet

WORKDIR /app/wrapper/api

COPY --from=builder --chown=10001:10001 /opt/proxy-bootstrap /opt/proxy-bootstrap
COPY --from=builder --chown=10001:10001 /app/wrapper/api /app/wrapper/api
COPY --from=builder --chown=10001:10001 /app/wrapper/shared /app/wrapper/shared
COPY --from=builder --chown=10001:10001 /app/rivet/node_modules /app/rivet/node_modules
COPY --from=builder --chown=10001:10001 /app/rivet/packages/core /app/rivet/packages/core
COPY --from=builder --chown=10001:10001 /app/rivet/packages/node /app/rivet/packages/node
COPY --from=builder --chown=10001:10001 /app/rivet/packages/evaluations /app/rivet/packages/evaluations
COPY --chown=10001:10001 image/lib/load-env.sh /opt/rivet/lib/load-env.sh
COPY --chown=10001:10001 image/lib/bootstrap-deployment-storage-settings.mjs /opt/rivet/lib/bootstrap-deployment-storage-settings.mjs
COPY --chown=10001:10001 image/api/entrypoint.sh /opt/rivet/api-entrypoint.sh

RUN chmod +x /opt/rivet/lib/load-env.sh /opt/rivet/api-entrypoint.sh

ENV HOME=/home/rivet
ENV PORT=8080
ENV RIVET_WORKSPACE_ROOT=/workspace
ENV RIVET_WORKFLOWS_ROOT=/workflows
ENV RIVET_APP_DATA_ROOT=/data/rivet-app
ENV RIVET_RUNTIME_LIBRARIES_ROOT=/data/runtime-libraries
ENV RIVET_RUNTIME_PROCESS_ROLE=api

EXPOSE 8080
USER 10001:10001

ENTRYPOINT ["/opt/rivet/api-entrypoint.sh"]
