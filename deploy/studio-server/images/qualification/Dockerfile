# syntax=docker/dockerfile:1.7
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
ARG SOURCE_SHA
ARG TARGETARCH=amd64
RUN apk add --no-cache git chromium openssl util-linux curl ca-certificates bash && corepack enable
RUN curl -fsSLo /tmp/helm.tgz https://get.helm.sh/helm-v3.20.1-linux-${TARGETARCH}.tar.gz && \
    curl -fsSLo /tmp/helm.sha https://get.helm.sh/helm-v3.20.1-linux-${TARGETARCH}.tar.gz.sha256sum && \
    cd /tmp && echo "$(awk '{print $1}' helm.sha)  helm.tgz" | sha256sum -c - && tar -xzf helm.tgz && mv linux-${TARGETARCH}/helm /usr/local/bin/helm && rm -rf helm.tgz helm.sha linux-${TARGETARCH}
RUN curl -fsSLo /usr/local/bin/kubectl https://dl.k8s.io/release/v1.34.3/bin/linux/${TARGETARCH}/kubectl && \
    curl -fsSLo /tmp/kubectl.sha https://dl.k8s.io/release/v1.34.3/bin/linux/${TARGETARCH}/kubectl.sha256 && \
    echo "$(cat /tmp/kubectl.sha)  /usr/local/bin/kubectl" | sha256sum -c - && chmod 755 /usr/local/bin/kubectl && rm /tmp/kubectl.sha
# Only a fresh single-commit source clone enters the context, never the user's
# Git config, old history, working files or private operation artifacts.
COPY source /app
RUN cd /app && \
    node deploy/studio-server/images/qualification/install-dependencies.mjs "$SOURCE_SHA" && \
    YARN_NODE_LINKER=node-modules yarn build:runtime && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet2-evaluations run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-shared run build && \
    YARN_NODE_LINKER=node-modules yarn workspace @valerypopoff/rivet-studio-server-web run build
ENV YARN_NODE_LINKER=node-modules PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium PLAYWRIGHT_HEADLESS=1 PLAYWRIGHT_SLOW_MO=0
WORKDIR /app
RUN addgroup -g 10001 qualification && adduser -D -u 10001 -G qualification qualification && \
    mkdir -p /qualification/private /home/qualification && chown -R 10001:10001 /app /qualification /home/qualification
USER 10001:10001
CMD ["node", "-e", "setInterval(()=>{},1000)"]
