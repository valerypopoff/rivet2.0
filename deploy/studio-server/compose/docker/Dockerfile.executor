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
COPY . .

RUN --mount=type=cache,target=/root/.cache/yarn \
    YARN_NODE_LINKER=node-modules YARN_CHECKSUM_BEHAVIOR=ignore yarn install --immutable
RUN YARN_NODE_LINKER=node-modules yarn build:runtime && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet2-evaluations run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-shared run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-bootstrap run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-executor run build

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
COPY --from=builder --chown=10001:10001 /app/packages /app/packages
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

EXPOSE 21889
USER 10001:10001

ENTRYPOINT ["/opt/rivet/executor-entrypoint.sh"]
