FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN node -e "import('hash-wasm')"
COPY --from=build /app/dist ./dist
COPY --from=build /app/generated ./generated
COPY --from=build /app/docs/developer-kit/v1/biunivers.app.schema.json \
  ./docs/developer-kit/v1/biunivers.app.schema.json
COPY --from=build /app/docs/developer-kit/v1/BIUNIVERS_APP_PROTOCOL_V1.md \
  ./docs/developer-kit/v1/BIUNIVERS_APP_PROTOCOL_V1.md
COPY --from=build /app/docs/developer-kit/v1/biunivers.open-resource.schema.json \
  ./docs/developer-kit/v1/biunivers.open-resource.schema.json
COPY --from=build /app/docs/developer-kit/v1/BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md \
  ./docs/developer-kit/v1/BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md
COPY --from=build /app/docs/developer-kit/v1/BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md \
  ./docs/developer-kit/v1/BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 8080 8081
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "dist/server/index.js"]
