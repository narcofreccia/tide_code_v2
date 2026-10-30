# Tide relay — build from this directory: docker build -t tide-relay apps/relay
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund && npm cache clean --force
COPY src ./src
ENV PORT=8787 HOST=0.0.0.0 RELAY_DB=/data/relay.db NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8787
# RELAY_KEY must be provided at run time (docker run -e RELAY_KEY=...)
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/bin.ts"]
