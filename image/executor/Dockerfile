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

RUN corepack enable && corepack prepare yarn@4.6.0 --activate

WORKDIR /app

COPY wrapper/bootstrap/proxy-bootstrap/ /opt/proxy-bootstrap/
RUN --mount=type=cache,target=/root/.npm npm --prefix /opt/proxy-bootstrap ci

COPY --from=rivet_dependency_metadata . /app/rivet/
WORKDIR /app/rivet
RUN --mount=type=cache,target=/root/.cache/yarn YARN_NODE_LINKER=node-modules YARN_CHECKSUM_BEHAVIOR=ignore yarn install --immutable || YARN_NODE_LINKER=node-modules YARN_CHECKSUM_BEHAVIOR=ignore yarn install

COPY --from=rivet_source . /app/rivet/
WORKDIR /app/rivet
RUN YARN_NODE_LINKER=node-modules yarn build:runtime

COPY wrapper/executor/build/bundle-executor.cjs /app/wrapper/executor/build/bundle-executor.cjs
RUN NODE_PATH=/app/rivet/node_modules node /app/wrapper/executor/build/bundle-executor.cjs

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

COPY --from=builder --chown=10001:10001 /opt/proxy-bootstrap /opt/proxy-bootstrap
COPY --from=builder --chown=10001:10001 /app/rivet/packages/app-executor/bin/executor-bundle.cjs /app/executor-bundle.cjs
COPY --chown=10001:10001 image/lib/load-env.sh /opt/rivet/lib/load-env.sh
COPY --chown=10001:10001 image/executor/entrypoint.sh /opt/rivet/executor-entrypoint.sh

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
