# Build a partir da raiz do repositório:  docker build -f backend/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/drizzle ./drizzle
COPY backend/package.json ./
COPY index.html /app/index.html
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
