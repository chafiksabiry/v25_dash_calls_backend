require('dotenv').config();

/**
 * Configuration lue dans l'environnement. Aucune valeur secrète par défaut : JWT_SECRET et l'adresse MongoDB (MONGO_URI, MONGODB_URI, MONGO_URL
 * ou DATABASE_URL) doivent être posés (Railway). Sans eux, `assertRequiredEnv()` (appelé au démarrage par app.js) arrête le service avec un message explicite,
 * et les middlewares d'authentification refusent tous les jetons.
 */
// Adresse MongoDB : première variable définie (MONGO_URL et DATABASE_URL sont fournies par le plugin Mongo de Railway).
const MONGO_URI_VARS = ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL'];

/** Nom de la variable qui fournit l'adresse MongoDB (jamais sa valeur), ou null. */
function mongoUriSource(env = process.env) {
  return MONGO_URI_VARS.find((name) => String(env[name] || '').trim()) || null;
}

const config = {
  PORT: process.env.PORT || 5006,
  MONGODB_URI: mongoUriSource() ? String(process.env[mongoUriSource()]).trim() : '',
  MONGODB_URI_SOURCE: mongoUriSource(),
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '24h',
  NODE_ENV: process.env.NODE_ENV || 'pre-production'
};

/** Variables sans lesquelles le service ne doit pas démarrer. Renvoie la liste des manquantes (vide si tout est là). */
function missingRequiredEnv(env = process.env) {
  const missing = [];
  if (!String(env.JWT_SECRET || '').trim()) missing.push('JWT_SECRET');
  if (!mongoUriSource(env)) missing.push(`adresse MongoDB (${MONGO_URI_VARS.join(', ')})`);
  return missing;
}

function assertRequiredEnv(env = process.env) {
  const missing = missingRequiredEnv(env);
  if (missing.length) {
    throw new Error(`Configuration incomplète : variable(s) ${missing.join(', ')} absente(s). Le service refuse de démarrer.`);
  }
}

module.exports = { config, missingRequiredEnv, assertRequiredEnv, mongoUriSource, MONGO_URI_VARS };
