FROM oven/bun:1.4.3 AS build

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

FROM oven/bun:1.4.3

WORKDIR /app
COPY --from=build /app/package.json /app/bun.lockb ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/docs/help ./docs/help
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/web/src/i18n ./web/src/i18n
RUN mkdir -p /app/data

EXPOSE 8085
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["bun", "-e", "fetch('http://127.0.0.1:8085/api/health').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "run", "server/index.ts"]
