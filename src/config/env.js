require('dotenv').config();

/**
 * Configuration lue dans l'environnement. Aucune valeur secrète par défaut : JWT_SECRET et l'adresse MongoDB doivent être
 * posés (Railway). Sans eux, `assertRequiredEnv()` (appelé au démarrage par app.js) arrête le service avec un message explicite,
 * et les middlewares d'authentification refusent tous les jetons.
 */
const config = {
  PORT: process.env.PORT || 5006,
  MONGODB_URI: process.env.MONGO_URI || process.env.MONGODB_URI || '',
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '24h',
  NODE_ENV: process.env.NODE_ENV || 'pre-production'
};

/** Variables sans lesquelles le service ne doit pas démarrer. Renvoie la liste des manquantes (vide si tout est là). */
function missingRequiredEnv(env = process.env) {
  const missing = [];
  if (!String(env.JWT_SECRET || '').trim()) missing.push('JWT_SECRET');
  if (!String(env.MONGO_URI || env.MONGODB_URI || '').trim()) missing.push('MONGO_URI (ou MONGODB_URI)');
  return missing;
}

function assertRequiredEnv(env = process.env) {
  const missing = missingRequiredEnv(env);
  if (missing.length) {
    throw new Error(`Configuration incomplète : variable(s) ${missing.join(', ')} absente(s). Le service refuse de démarrer.`);
  }
}

module.exports = { config, missingRequiredEnv, assertRequiredEnv };
