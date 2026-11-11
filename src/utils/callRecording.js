const OBJECT_ID = /^[a-f0-9]{24}$/i;
const CALL_SID = /^CA[0-9a-zA-Z]{32}$/;
const RECORDING_SID = /^RE[0-9a-zA-Z]{32}$/;
/** Les enregistrements ne se téléchargent (avec nos identifiants Twilio) que depuis api.twilio.com. */
const TWILIO_RECORDING_URL = /^https:\/\/api\.twilio\.com\/[^\s?#]+$/;

/** Corps de `POST /calls/recording` (envoyé par l'orchestrateur après le rappel Twilio). Lève une Error(message) si inexploitable. */
function parseRecordingBody(body = {}) {
  const sid = String(body.sid || '').trim();
  if (!CALL_SID.test(sid)) throw new Error('sid invalide');
  const companyId = String(body.companyId || '').trim();
  if (!OBJECT_ID.test(companyId)) throw new Error('companyId invalide');
  const recordingSid = String(body.recordingSid || '').trim();
  if (!RECORDING_SID.test(recordingSid)) throw new Error('recordingSid invalide');
  const recordingUrl = String(body.recordingUrl || '').trim().replace(/\.(mp3|wav)$/i, '');
  if (!TWILIO_RECORDING_URL.test(recordingUrl)) throw new Error('recordingUrl invalide');
  const durationSeconds = Math.round(Number(body.durationSeconds));
  return { sid, companyId, recordingSid, recordingUrl, durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null };
}

/**
 * Rattache l'enregistrement d'un appel au document d'appel EXISTANT (par CallSid). Ne crée jamais de document :
 * 404 si l'appel n'est pas encore inscrit (l'orchestrateur réessaie), 409 si l'appel appartient à une autre entreprise.
 * `archive(url)` copie l'audio chez Cloudinary (URL jouable par le lecteur du journal) ; son échec n'empêche pas de garder
 * l'URL Twilio. Idempotent : un même enregistrement déjà rattaché ne relance pas la copie.
 * @returns {Promise<{status: number, body: object}>}
 */
async function attachRecording({ Call, archive }, rawBody) {
  let rec;
  try {
    rec = parseRecordingBody(rawBody);
  } catch (e) {
    return { status: 400, body: { success: false, message: e.message } };
  }
  const call = await Call.findOne({ sid: rec.sid }).select('companyId recording_url recording_url_cloudinary').lean();
  if (!call) return { status: 404, body: { success: false, pending: true, message: 'Appel pas encore inscrit' } };
  if (!call.companyId || String(call.companyId) !== rec.companyId) return { status: 409, body: { success: false, message: 'Appel d’une autre entreprise' } };
  if (call.recording_url === rec.recordingUrl && call.recording_url_cloudinary) return { status: 200, body: { success: true, archived: true, unchanged: true } };

  let cloudinaryUrl = call.recording_url === rec.recordingUrl ? call.recording_url_cloudinary || null : null;
  if (!cloudinaryUrl) {
    try {
      cloudinaryUrl = (await archive(`${rec.recordingUrl}.mp3`)) || null;
    } catch (e) {
      console.warn('[call-recording] archivage impossible, URL Twilio conservée:', e.message);
    }
  }
  const set = { recording_url: rec.recordingUrl };
  if (cloudinaryUrl) set.recording_url_cloudinary = cloudinaryUrl;
  await Call.updateOne({ sid: rec.sid, companyId: call.companyId }, { $set: set });
  return { status: 200, body: { success: true, archived: Boolean(cloudinaryUrl) } };
}

module.exports = { parseRecordingBody, attachRecording };
