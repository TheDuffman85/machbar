FROM node:24-bookworm-slim AS build
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
COPY --from=build --chown=node:node /prod/api ./api
COPY --from=build --chown=node:node /build/apps/web/dist ./web
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "api/dist/index.js"]
