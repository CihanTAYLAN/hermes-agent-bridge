# syntax=docker/dockerfile:1.7

ARG NODE_BUILD_IMAGE=node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ARG NODE_RUNTIME_IMAGE=node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

FROM ${NODE_BUILD_IMAGE} AS build
WORKDIR /workspace
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bridge-api/package.json apps/bridge-api/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY apps/bridge-api apps/bridge-api
COPY contracts contracts
RUN pnpm --filter @hermes-bridge/api build \
  && pnpm --filter @hermes-bridge/api --prod deploy --legacy /opt/bridge-api \
  && test -f /opt/bridge-api/dist/main.js

FROM ${NODE_RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# The service runs with node directly; package managers only expand the runtime attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build --chown=node:node /opt/bridge-api/ ./
COPY --from=build --chown=node:node /workspace/contracts/ /contracts/

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>{if(!r.ok)throw Error(r.status)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
