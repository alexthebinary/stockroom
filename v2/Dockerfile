# ProfitIndex v2: one image, the API serving the built PWA. Runs on any host
# with Docker and a Postgres 16 (docker compose up gives you both).
FROM node:22-bookworm-slim AS build
# Prisma's migration engine links OpenSSL 3, which the slim image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci --workspace=@pi/domain --workspace=@pi/api --workspace=@pi/web --include-workspace-root
COPY packages packages
COPY apps apps
# The commit, named in every feedback report (deploy/start.sh passes it).
ARG APP_VERSION=dev
RUN VITE_APP_VERSION=$APP_VERSION npm run build -w @pi/web && npm run build -w @pi/api

FROM node:22-bookworm-slim
# Prisma's migration engine links OpenSSL 3, which the slim image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=4100
COPY --from=build /app /app
EXPOSE 4100
# Apply any new migrations, then serve. A brand-new database opens the setup wizard.
CMD ["sh", "-c", "npm run migrate -w @pi/api && node apps/api/dist/server.js"]
