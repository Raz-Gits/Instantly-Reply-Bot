# Build stage: compile TypeScript with dev dependencies.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies + compiled output only.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# In production, client profiles come from the CLIENTS_JSON env var (DEPLOY.md).
# config/ ships only the example; local docker runs can mount a real clients.json.
COPY config ./config
EXPOSE 3000
CMD ["node", "dist/index.js"]
