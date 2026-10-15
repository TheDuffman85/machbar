# The build output is plain JavaScript, so it is built once on the runner platform for every target platform.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build && pnpm --filter @machbar/api deploy --prod --legacy /prod/api

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data WEB_DIR=/app/web
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /prod/api ./api
COPY --from=build /build/apps/web/dist ./web
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/machbar-entrypoint
RUN mkdir -m 700 /app/data && chown node:node /app/data
# The entrypoint repairs mounted data permissions, then drops to node before exec.
USER root
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["machbar-entrypoint"]
CMD ["node", "api/dist/index.js"]
