FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/tmp/chaos

ENV NODE_ENV=production
EXPOSE 4000

CMD ["sh", "-c", "node scripts/migrate.js && node scripts/seed.js && node src/bootstrap.js"]
