# ---- build stage: full dependencies, compile TypeScript ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY document-layout ./document-layout
# Full install, INCLUDING devDependencies -- tsc lives there. The runtime stage
# below installs again with --omit=dev, so none of this reaches the final image.
# The `puppeteer` dev dependency would download a Chrome here that nothing runs.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# scripts/copy-template-fonts.ts (run by `npm run build`) copies the overlay
# editor's bundled font files into dist/ after tsc compiles.
COPY scripts ./scripts
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim

# Keep the local conversion adapter available until the worker is accepted and
# DOCUMENT_CONVERTER is switched for a full revision. Remove this only after
# the defined rollback window has passed.
RUN apt-get update && \
    apt-get install -y --no-install-recommends libreoffice-core libreoffice-writer && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Make production the default runtime environment. The cron authorizer and error
# handler gate behavior on NODE_ENV; an unset value must not fall back to dev.
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=build /app/document-layout ./document-layout
# `npm ci` rather than `npm install`: ci is reproducible from the lockfile, while
# install can silently resolve different versions between builds.
RUN npm ci --omit=dev

# Compiled output only -- no sources, no build tooling. Everything the server
# needs at runtime lives under src/ and therefore under dist/: nothing outside it
# is required at runtime. The one exception (the overlay editor's bundled font
# files) isn't TypeScript, so it can't reach dist/ via tsc; the build stage's
# copy-template-fonts.ts step puts it there explicitly instead.
COPY --from=build /app/dist ./dist

EXPOSE 5001

CMD ["node", "dist/server.js"]
