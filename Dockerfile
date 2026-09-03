FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
# Drop devDependencies from the runtime image. tsx is a runtime dependency
# (the supervisor runs boot.ts and the worker through it) and survives this.
RUN npm prune --omit=dev
# No `USER node`: Railway mounts volumes root-owned, so a non-root process
# could not create secret.key or the database on /data.
# No VOLUME instruction either: Railway's builder rejects it, and both
# docker-compose.yml and the Railway template mount /data explicitly.
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
