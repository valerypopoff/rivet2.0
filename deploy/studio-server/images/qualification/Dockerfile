# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS esbuild-security
ARG TARGETARCH
COPY source/deploy/studio-server/images/lib/rebuild-esbuild.sh /rebuild-esbuild.sh
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build sh /rebuild-esbuild.sh "$TARGETARCH"

FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS helm-security
ARG TARGETARCH
COPY source/deploy/studio-server/images/qualification/rebuild-helm.sh /rebuild-helm.sh
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build sh /rebuild-helm.sh "$TARGETARCH"

FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS kubectl-security
ARG TARGETARCH
COPY source/deploy/studio-server/images/qualification/kubectl /kubectl-policy
COPY source/deploy/studio-server/images/qualification/rebuild-kubectl.sh /rebuild-kubectl.sh
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build sh /rebuild-kubectl.sh "$TARGETARCH"

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS qualification-toolchain
ARG TARGETARCH=amd64
COPY source/deploy/studio-server/images/lib/harden-package-manager-caches.mjs /opt/rivet/harden-package-manager-caches.mjs
RUN apk add --no-cache git chromium ffmpeg openssl util-linux curl ca-certificates bash && corepack enable && \
    npm install -g npm@11.21.1 && \
    npm install --prefix /tmp/rivet-npm-security --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact undici@6.29.1 && \
    rm -rf /usr/local/lib/node_modules/npm/node_modules/undici && \
    mv /tmp/rivet-npm-security/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici && \
    rm -rf /tmp/rivet-npm-security /root/.npm && \
    node /opt/rivet/harden-package-manager-caches.mjs npm
COPY --from=helm-security /out/helm /usr/local/bin/helm
COPY --from=helm-security /out/helm-build.txt /out/helm-LICENSE /opt/rivet/toolchain/
COPY --from=kubectl-security /out/kubectl /usr/local/bin/kubectl
COPY --from=kubectl-security /out/kubectl-build.txt /out/kubectl-LICENSE /opt/rivet/toolchain/
# Only a fresh single-commit source clone enters the context, never the user's
# Git config, old history, working files or private operation artifacts.
RUN addgroup -g 10001 qualification && adduser -D -u 10001 -G qualification qualification && \
    mkdir -p /app /qualification/private /home/qualification && chown 10001:10001 /app /qualification /qualification/private /home/qualification
COPY source/deploy/studio-server/images/qualification/verify-toolchain.mjs /opt/rivet/verify-toolchain.mjs
USER 10001:10001
RUN node /opt/rivet/verify-toolchain.mjs

FROM qualification-toolchain
COPY --chown=10001:10001 source /app
WORKDIR /app
ARG SOURCE_SHA
RUN node deploy/studio-server/images/qualification/install-dependencies.mjs "$SOURCE_SHA" && \
    node deploy/studio-server/images/qualification/prepare-browser-tools.mjs && \
    YARN_NODE_LINKER=node-modules yarn build:runtime && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet2-evaluations run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-shared run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-web run build
COPY --from=esbuild-security --chown=10001:10001 /out/@esbuild /app/node_modules/@esbuild
COPY --from=esbuild-security --chown=10001:10001 /out/esbuild /app/node_modules/esbuild/bin/esbuild
RUN --mount=type=bind,source=source/deploy/studio-server/images/lib/verify-runtime-dependencies.mjs,target=/tmp/verify-runtime-dependencies.mjs,readonly \
    node /tmp/verify-runtime-dependencies.mjs npm
ENV YARN_NODE_LINKER=node-modules PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium PLAYWRIGHT_HEADLESS=1 PLAYWRIGHT_SLOW_MO=0
CMD ["node", "-e", "setInterval(()=>{},1000)"]
