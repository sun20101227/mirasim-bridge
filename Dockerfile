ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production MIRASIM_CONFIG=/data/config.json
WORKDIR /app
COPY --chown=node:node mirasim-bridge.js ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node web/ ./web/
COPY --chown=node:node scripts/deployment.js scripts/export-credential.js scripts/prepare-container.js scripts/container-config.js scripts/healthcheck.js scripts/account-login.js scripts/panel-bridge.js ./scripts/
COPY THIRD-PARTY-NOTICES.md ./
COPY licenses/ ./licenses/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/app/scripts/healthcheck.js"]
ENTRYPOINT ["node", "/app/mirasim-bridge.js"]
CMD ["serve", "--config", "/data/config.json"]
