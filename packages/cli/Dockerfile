FROM node:23.11.0-alpine3.21

WORKDIR /app
VOLUME /project

ARG RIVET_CLI_VERSION=2.0.11
RUN npm install -g "@valerypopoff/rivet2-cli@${RIVET_CLI_VERSION}"

COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
