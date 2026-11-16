# Build context = repo root:  docker build -f apps/api/Dockerfile .
FROM node:24-alpine
WORKDIR /app/api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/api/ ./
COPY apps/web/ /app/web/
RUN mkdir -p /app/api/data && chown -R node:node /app/api/data
ENV HOST=0.0.0.0 PORT=5180 NODE_ENV=production
USER node
EXPOSE 5180
CMD ["node", "src/server.js"]
