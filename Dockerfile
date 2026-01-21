# Backend Dockerfile - Telnyx Call Manager
FROM node:18-alpine

# Définir le répertoire de travail
WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer les dépendances
RUN npm ci --only=production

# Copier le code source
COPY . .

ENV TELNYX_API_KEY=KEY019690D1904628BDD9BA5E852B56E231_pje6tiJqaeCqb5uD9Z586f
ENV TELNYX_APPLICATION_ID=2800936068575135000
ENV WEBHOOK_URL=https://api-calls.harx.ai/webhook
ENV NODE_ENV=production


# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('https://api-calls.harx.ai/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Démarrer l'application
CMD ["node", "server.js"]

