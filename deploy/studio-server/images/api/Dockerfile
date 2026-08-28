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

RUN apk add --no-cache git && \
    corepack enable && \
    corepack prepare pnpm@10.18.3 --activate

WORKDIR /app
COPY . .

RUN --mount=type=cache,target=/root/.cache/yarn \
    YARN_NODE_LINKER=node-modules YARN_CHECKSUM_BEHAVIOR=ignore yarn install --immutable
RUN YARN_NODE_LINKER=node-modules yarn build:runtime && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet2-evaluations run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-shared run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-bootstrap run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-api run build

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
    mkdir -p /workspace /workflows /data/rivet-app/plugins /data/rivet-app/logs /data/runtime-libraries /home/rivet /opt/rivet/lib /app && \
    chown -R 10001:10001 /workspace /workflows /data /home/rivet /opt/rivet /app

WORKDIR /app/packages/studio-server-api

COPY --from=builder --chown=10001:10001 /app/node_modules /app/node_modules
COPY --from=builder --chown=10001:10001 /app/packages /app/packages
COPY --chown=10001:10001 deploy/studio-server/images/lib/load-env.sh /opt/rivet/lib/load-env.sh
COPY --chown=10001:10001 deploy/studio-server/images/lib/bootstrap-deployment-storage-settings.mjs /opt/rivet/lib/bootstrap-deployment-storage-settings.mjs
COPY --chown=10001:10001 deploy/studio-server/images/api/entrypoint.sh /opt/rivet/api-entrypoint.sh

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
