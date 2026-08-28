# syntax=docker/dockerfile:1.7
FROM nginx:1.27-alpine

RUN apk add --no-cache curl && \
    addgroup -g 10001 -S rivet && \
    adduser -u 10001 -S -D -h /home/rivet -G rivet rivet && \
    mkdir -p /opt/rivet/lib /opt/rivet/proxy /tmp/nginx/conf.d /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp && \
    chown -R 10001:10001 /opt/rivet /tmp/nginx /usr/share/nginx/html

COPY --chown=10001:10001 deploy/studio-server/images/lib/load-env.sh /opt/rivet/lib/load-env.sh
COPY --chown=10001:10001 deploy/studio-server/images/proxy/entrypoint.sh /opt/rivet/proxy/entrypoint.sh
COPY --chown=10001:10001 deploy/studio-server/images/proxy/nginx.conf /etc/nginx/nginx.conf
COPY --chown=10001:10001 deploy/studio-server/images/proxy/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chown=10001:10001 deploy/studio-server/images/proxy/normalize-workflow-paths.sh /opt/rivet/proxy/normalize-workflow-paths.sh

RUN chmod +x /opt/rivet/lib/load-env.sh /opt/rivet/proxy/entrypoint.sh /opt/rivet/proxy/normalize-workflow-paths.sh

ENV NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx/templates
ENV NGINX_ENVSUBST_OUTPUT_DIR=/tmp/nginx/conf.d
ENV RIVET_WEB_UPSTREAM_HOST=web
ENV RIVET_WEB_UPSTREAM_PORT=3000
ENV RIVET_API_UPSTREAM_HOST=api
ENV RIVET_API_UPSTREAM_PORT=8080
ENV RIVET_EXECUTION_UPSTREAM_HOST=api
ENV RIVET_EXECUTION_UPSTREAM_PORT=8080
ENV RIVET_EXECUTOR_UPSTREAM_HOST=executor
ENV RIVET_EXECUTOR_UPSTREAM_PORT=21889
ENV RIVET_PROXY_RESOLVER=127.0.0.11
ENV RIVET_PROXY_READ_TIMEOUT=180s

EXPOSE 8080
USER 10001:10001

ENTRYPOINT ["/opt/rivet/proxy/entrypoint.sh"]
