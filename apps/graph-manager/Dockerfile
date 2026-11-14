# syntax=docker/dockerfile:1
# graph-manager: one image for a laptop, a VM or OpenShift. Build from the repository root:
#   docker build -f apps/graph-manager/Dockerfile -t graph-manager:dev .
# The build needs HTTPS only (npm registry, GitHub); it does not use apt. Behind a TLS-intercepting proxy, pass its CA:
#   docker build --secret id=ca,src=/path/to/ca-bundle.crt -f apps/graph-manager/Dockerfile -t graph-manager:dev .

# node:22-bookworm already ships python3, make and g++ (node-pty is a native addon and compiles here) and git,
# openssh-client, procps and ca-certificates (which the runtime needs), so neither stage has to reach a Debian mirror.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/graph-execution/package.json packages/graph-execution/
COPY apps/graph-manager/package.json apps/graph-manager/
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm
ARG TARGETARCH
# tini reaps the zombies of detached runs and forwards signals. Pinned by checksum (v0.19.0 release assets).
ADD --chmod=755 --checksum=sha256:93dcc18adc78c65a028a84799ecf8ad40c936fdfc5f2a57b1acda5a8117fa82c \
    https://github.com/krallin/tini/releases/download/v0.19.0/tini-amd64 /tmp/tini-amd64
ADD --chmod=755 --checksum=sha256:07952557df20bfd2a95f9bef198b445e006171969499a1d361bd9e6f8e5e0e81 \
    https://github.com/krallin/tini/releases/download/v0.19.0/tini-arm64 /tmp/tini-arm64
RUN mv "/tmp/tini-${TARGETARCH:-amd64}" /usr/bin/tini && rm -f /tmp/tini-* && /usr/bin/tini --version
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm install -g @anthropic-ai/claude-code && npm cache clean --force
WORKDIR /app
COPY --from=build /app /app
# UID 1000 owns the volumes (plain Docker; /opt/gm-tools holds the sandbox tools, KAN-88); OpenShift runs an arbitrary UID in group 0, so they are group-0 writable too.
RUN ln -s /app/packages/graph-execution/dist/cli.js /usr/local/bin/graph-execution \
 && mkdir -p /data/home /workspaces /opt/gm-tools && chown -R 1000:0 /data /workspaces /opt/gm-tools \
 && chmod -R g=u /data /workspaces /opt/gm-tools
# The GIT_* defaults let graph-execution runs commit; override them with -e.
ENV GM_HOST=0.0.0.0 GM_PORT=7420 GM_DATA_DIR=/data GM_WORKSPACES_DIR=/workspaces HOME=/data/home \
    GM_GRAPH_EXECUTION_BIN=/app/packages/graph-execution/dist/cli.js \
    GIT_AUTHOR_NAME=graph-manager GIT_AUTHOR_EMAIL=graph-manager@localhost \
    GIT_COMMITTER_NAME=graph-manager GIT_COMMITTER_EMAIL=graph-manager@localhost
USER 1000
EXPOSE 7420
VOLUME ["/data", "/workspaces", "/opt/gm-tools"]
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:7420/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/packages/graph-execution/dist/cli.js", "manager", "--no-open"]
