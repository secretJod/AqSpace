# Build context = repo root:  docker build -f aq-api/Dockerfile .
FROM node:24-alpine
WORKDIR /app/aq-api
COPY aq-api/package.json aq-api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY aq-api/ ./
COPY lecture-notes-ui/ /app/lecture-notes-ui/
RUN mkdir -p /app/aq-api/data && chown -R node:node /app/aq-api/data
ENV HOST=0.0.0.0 PORT=5180 NODE_ENV=production
USER node
EXPOSE 5180
CMD ["node", "src/server.js"]
