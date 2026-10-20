# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --strict-ssl=true
# .dockerignore is an allowlist: no .git, private data, tests, or local secrets.
COPY . ./
ARG RAILWAY_GIT_COMMIT_SHA
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA
RUN npm run build:railway

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
ARG RAILWAY_GIT_COMMIT_SHA
ENV VDS_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA
EXPOSE 3000
CMD ["npm", "run", "start:railway"]
