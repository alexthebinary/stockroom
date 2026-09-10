# Single-image build, for any host that takes a container (Fly.io, Cloud Run,
# a VPS). Serves the API and the built UI from one process on one port.
FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
# Install scripts are needed here: Prisma's query engine and esbuild's binary
# both arrive via postinstall, and npm 11 blocks them by default.
RUN npm --prefix backend install --ignore-scripts=false \
    && npm --prefix frontend install --ignore-scripts=false

COPY . .
# The client must be generated BEFORE tsc, or every Prisma callback compiles as
# `any` and the build fails on noImplicitAny. Generated here for types (the
# model types are identical across providers) and regenerated at boot by the
# entrypoint against whichever provider DATABASE_URL actually names.
# `npm run` executes with cwd set to the package directory, so the relative
# --schema path inside generate:pg resolves; `npm exec` does not.
RUN npm --prefix backend run generate:pg \
    && npm --prefix frontend run build \
    && npm --prefix backend run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend/dist ./frontend/dist

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
EXPOSE 4000

COPY --from=build /app/backend/docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

# The entrypoint detects the provider, migrates, and seeds only an empty
# database — a restart never wipes what testers entered.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
