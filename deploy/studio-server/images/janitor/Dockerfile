# syntax=docker/dockerfile:1.7
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS dependencies
# Only ws is needed by the mounted, bundled cleanup program. Match yarn.lock.
RUN npm install --prefix /runtime --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact ws@8.21.0

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
RUN apk add --no-cache ca-certificates && \
    rm -rf /usr/local/lib/node_modules /opt/yarn-* && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack && \
    addgroup -g 10001 -S rivet && adduser -u 10001 -S -D -G rivet rivet && \
    mkdir -p /app/packages/studio-server-api && \
    printf '{"private":true,"type":"module"}\n' > /app/packages/studio-server-api/package.json
COPY --from=dependencies /runtime/node_modules /app/node_modules
WORKDIR /app/packages/studio-server-api
USER 10001:10001
CMD ["node", "--preserve-symlinks-main", "/qualification/janitor.mjs"]
