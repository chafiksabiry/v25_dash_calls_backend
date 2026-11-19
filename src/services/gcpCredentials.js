/**
 * Identifiants Google Cloud lus UNIQUEMENT dans les variables d'environnement (aucune clé dans le dépôt, aucun fichier écrit).
 *
 * Chaque variable contient le JSON complet d'un compte de service. Les guillemets entourant la valeur sont retirés et les `\n`
 * littéraux de `private_key` sont remplacés par de vrais retours à la ligne (cas courant quand le JSON est collé dans Railway).
 *
 * Sans variable valable : identifiants par défaut de Google (ADC : GOOGLE_APPLICATION_CREDENTIALS désignant un fichier hors
 * dépôt, ou compte de service de la machine). Rien ne plante au démarrage : l'appel Google échouera avec un message clair.
 * La valeur d'une variable n'est jamais journalisée.
 */

// GOOGLE_APPLICATION_CREDENTIALS : accepté s'il contient du JSON ; s'il désigne un fichier, il est laissé aux identifiants par défaut (ADC).
const ADC_PATH_VAR = 'GOOGLE_APPLICATION_CREDENTIALS';
const VERTEX_VARS = ['VERTEX_AI_CREDENTIALS', 'GCP_VERTEX_AI_CREDENTIALS', ADC_PATH_VAR];
const SPEECH_VARS = ['GCP_SPEECH_TO_TEXT_CREDENTIALS', ADC_PATH_VAR];
// Stockage : à défaut de variable dédiée, le compte de service Vertex (comportement historique).
const STORAGE_VARS = ['CLOUD_STORAGE_CREDENTIALS', 'GCP_STORAGE_CREDENTIALS', 'GCP_CLOUD_STORAGE_CREDENTIALS', ...VERTEX_VARS];

/** JSON de compte de service -> objet (null si la valeur n'est pas du JSON). Lève une erreur si le JSON est invalide. */
function parseServiceAccountJson(raw) {
  let sanitized = String(raw || '').trim();
  if (sanitized.startsWith('"') && sanitized.endsWith('"')) sanitized = sanitized.slice(1, -1).trim();
  if (!sanitized.startsWith('{')) return null;
  const creds = JSON.parse(sanitized);
  if (creds && typeof creds.private_key === 'string') creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  return creds;
}

/**
 * Premier compte de service valable parmi `names`.
 * @returns {{ credentials?: object, source: string|null, error?: string }}
 */
function readServiceAccount(names, env = process.env) {
  const errors = [];
  for (const name of names) {
    const raw = env[name];
    if (!raw || !String(raw).trim()) continue;
    try {
      const credentials = parseServiceAccountJson(raw);
      if (!credentials && name === ADC_PATH_VAR) continue; // chemin de fichier : géré par ADC
      if (credentials && credentials.client_email && credentials.private_key) return { credentials, source: name };
      errors.push(`${name} ne contient pas le JSON d'un compte de service (client_email et private_key attendus)`);
    } catch (error) {
      errors.push(`${name} contient un JSON invalide`);
    }
  }
  return { source: null, ...(errors.length ? { error: errors.join(' ; ') } : {}) };
}

/**
 * Options d'authentification pour les clients Google (VertexAI.googleAuthOptions, SpeechClient, Storage).
 * `label` sert seulement aux messages. Avec un compte de service : `{ credentials, projectId? }` ; sinon `{}` (ADC).
 */
function googleAuthOptions(names, label, env = process.env, logger = console) {
  const found = readServiceAccount(names, env);
  if (found.credentials) {
    return { credentials: found.credentials, ...(found.credentials.project_id ? { projectId: found.credentials.project_id } : {}) };
  }
  if (found.error) logger.error(`❌ [gcpCredentials] ${label} : ${found.error}. Identifiants par défaut de Google (ADC) utilisés à la place.`);
  else {
    logger.warn(
      `⚠️ [gcpCredentials] ${label} : aucune des variables ${names.join(', ')} n'est définie. ` +
        'Identifiants par défaut de Google (ADC) utilisés ; sans eux, les appels Google échoueront.'
    );
  }
  return {};
}

module.exports = { VERTEX_VARS, SPEECH_VARS, STORAGE_VARS, parseServiceAccountJson, readServiceAccount, googleAuthOptions };
