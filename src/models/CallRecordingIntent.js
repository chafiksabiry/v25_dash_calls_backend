const mongoose = require('mongoose');

/**
 * Décision d'enregistrement d'un appel, envoyée par l'orchestrateur (POST /api/calls/recording/intent) — éventuellement
 * AVANT que le document d'appel n'existe. Une ligne par CallSid ; la première décision l'emporte. Lue en repli quand
 * l'appel n'a pas (encore) de statut propre. Les valeurs sont celles de `recordingStatus` / `recordingReason` de `Call`.
 */
const schema = new mongoose.Schema({
  sid: { type: String, required: true, unique: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
  recordingStatus: { type: String, enum: ['recorded', 'not_recorded', 'pending'], required: true },
  recordingReason: { type: String, enum: ['recorded_planned', 'plan_excludes', 'disabled_by_company', 'not_applicable', 'technical_failure', 'lookup_failed'], default: null },
  decidedAt: { type: Date, default: Date.now },
  history: { type: [{ _id: false, recordingStatus: String, recordingReason: String, decidedAt: Date, replacedAt: Date }], default: undefined },
}, { timestamps: true });

module.exports = mongoose.models.CallRecordingIntent || mongoose.model('CallRecordingIntent', schema);
