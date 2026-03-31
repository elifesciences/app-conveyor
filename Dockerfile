FROM oven/bun:1.3.11 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY index.ts ./
COPY src/ ./src/

# Runtime
ENV PORT=3000
ENV DB_PATH=/data/conveyor.db
VOLUME ["/data"]

EXPOSE 3000
CMD ["bun", "run", "index.ts"]
