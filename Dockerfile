FROM node:22-bookworm-slim

WORKDIR /app

# Install deps from lockfile only — never reuse a host/copied node_modules tree
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
