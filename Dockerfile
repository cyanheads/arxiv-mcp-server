# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
# ==============================================================================
FROM oven/bun:1.3 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# `--ignore-scripts` skips native install scripts (e.g. better-sqlite3's node-gyp
# build) — the Bun base image has no C++ toolchain, and the runtime image is
# Bun-only, which uses `bun:sqlite` rather than `better-sqlite3` at runtime.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts.
# ==============================================================================
FROM oven/bun:1.3-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance and to ensure only
# production dependencies are installed.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
LABEL org.opencontainers.image.title="arxiv-mcp-server"
LABEL org.opencontainers.image.description="MCP server for arXiv academic paper search, metadata retrieval, and full-text reading."
LABEL org.opencontainers.image.source="https://github.com/cyanheads/arxiv-mcp-server"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Copy dependency manifests
COPY package.json bun.lock ./

# Install only production dependencies, ignoring any lifecycle scripts (like 'prepare')
# that are not needed in the final production image.
RUN bun install --production --frozen-lockfile --ignore-scripts

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# These are not bundled by default to keep the base image lean. Enable at build time
# with: docker build --build-arg OTEL_ENABLED=true
ARG OTEL_ENABLED=true
RUN if [ "$OTEL_ENABLED" = "true" ]; then \
      bun add @hono/otel \
        @opentelemetry/instrumentation-http \
        @opentelemetry/exporter-metrics-otlp-http \
        @opentelemetry/exporter-trace-otlp-http \
        @opentelemetry/instrumentation-pino \
        @opentelemetry/resources \
        @opentelemetry/sdk-metrics \
        @opentelemetry/sdk-node \
        @opentelemetry/sdk-trace-node \
        @opentelemetry/semantic-conventions; \
    fi

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# Copy the mirror lifecycle scripts. `bun run mirror:init` / `mirror:refresh` /
# `mirror:verify` invoke these directly (Bun runs `.ts` natively) — they must
# exist inside the container or the operator can't cold-init the mirror.
COPY --from=build /usr/src/app/scripts/arxiv-mirror-init.ts \
                  /usr/src/app/scripts/arxiv-mirror-refresh.ts \
                  /usr/src/app/scripts/arxiv-mirror-verify.ts \
                  /usr/src/app/scripts/_mirror-context.ts \
                  ./scripts/

# Emit a minimal `tsconfig.json` so Bun can resolve the `@/...` path alias the
# mirror scripts import through. Source `tsconfig.json` maps `@/*` to `./src/*`,
# but production only carries `./dist/*` — without this file, `bun run mirror:init`
# fails with `Cannot find module '@/config/server-config.js'`.
RUN echo '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./dist/*"]}}}' > tsconfig.json

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/arxiv-mcp-server && chown -R bun:bun /var/log/arxiv-mcp-server

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/arxiv-mcp-server"
ENV MCP_FORCE_CONSOLE_LOGGING="true"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
