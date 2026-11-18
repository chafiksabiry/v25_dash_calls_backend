/**
 * Écoute des enregistrements d'appels (décision du 18/11/2026) : l'URL d'un enregistrement n'est renvoyée qu'au titulaire
 * PROUVÉ du centre (session `isOwner === true`, hors agent et hors contact client) ou à une personne dont les droits
 * contiennent `calls.listen === true`. Tous les autres reçoivent `recording_url` et `recording_url_cloudinary` à null
 * (le statut d'enregistrement reste visible : l'appel « a » un enregistrement, la personne ne peut pas l'écouter).
 *
 * Fermé par défaut : sans jeton (appelant anonyme toléré en compatibilité), session illisible ou service d'inscription
 * indisponible, les URL sont retirées. Les jetons de service (scope vérifié par callsAccess) ne sont pas concernés.
 *
 * Source des droits : `GET /api/company-members/me` du service d'inscription (le jeton ne porte ni rôle ni droits),
 * lu via companyScope.callerSession (même cache court que le contrôle d'entreprise).
 */
const { callerSession } = require('../middleware/companyScope');

const RECORDING_FIELDS = ['recording_url', 'recording_url_cloudinary'];

/** Vrai si la session du service d'inscription autorise l'écoute. */
function canListenRecordings(session) {
  if (!session || typeof session !== 'object') return false;
  const provenOwner = session.isOwner === true && session.isAgent !== true && session.isClient !== true;
  const listen = Boolean(session.permissions && session.permissions['calls.listen'] === true);
  return provenOwner || listen;
}

/** Droit d'écoute de l'appelant de la requête (mémorisé sur la requête). Ne lève jamais : en cas de doute, false. */
async function callerCanListen(req) {
  if (!req) return false;
  if (req.callsService) return true;
  if (typeof req.canListenRecordings === 'boolean') return req.canListenRecordings;
  let allowed = false;
  if (req.auth) {
    try {
      allowed = canListenRecordings(await callerSession(req.auth));
    } catch (error) {
      console.warn(`[recording-access] droits illisibles pour ${req.auth.userId} : enregistrements masqués (${error && error.message})`);
      allowed = false;
    }
  }
  req.canListenRecordings = allowed;
  return allowed;
}

/** Copie de l'appel sans URL d'enregistrement (document mongoose ou objet). */
function stripRecording(call) {
  if (!call || typeof call !== 'object') return call;
  const plain = typeof call.toJSON === 'function' ? call.toJSON() : { ...call };
  for (const field of RECORDING_FIELDS) plain[field] = null;
  return plain;
}

/** Appels (un seul ou une liste) tels que l'appelant a le droit de les voir. */
async function applyRecordingAccess(req, data) {
  if (await callerCanListen(req)) return data;
  if (Array.isArray(data)) return data.map(stripRecording);
  return stripRecording(data);
}

module.exports = { canListenRecordings, callerCanListen, stripRecording, applyRecordingAccess, RECORDING_FIELDS };
