FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

# Build-time argument: set it in Dokploy (Build-time args) and watch it appear on the dashboard.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# Stamp the build so you can tell a fresh build from a plain restart.
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > /app/.build-time \
 && mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
