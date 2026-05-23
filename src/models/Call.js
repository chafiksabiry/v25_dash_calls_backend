


const mongoose = require("mongoose");
require('./Transaction');

const callSchema = new mongoose.Schema({
  call_id: {
    type: String,
    sparse: true, // Permet d'avoir des documents sans ce champ tout en gardant l'index
    index: true, // Index pour des recherches efficaces
    description: "Identifiant unique de l'appel fourni par Qalqul",
    required: function () {
      return this.provider === 'qalqul';
    }
  },
  agent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Agent",
    required: true,
  },
  lead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Lead",
  },
  sid: {
    type: String,
    required: function () {
      return this.provider === 'twilio';
    },
    unique: true, // Identifiant Twilio de l'appel
  },
  parentCallSid: {
    type: String,
    default: null, // SID de l'appel parent s'il y en a un
  },
  direction: {
    type: String,
    enum: ["inbound", "outbound", "outbound-dial", "outbound-api", "Inbound", "Outbound"],
    default: "outbound",
    required: true,
  },
  from: {
    type: String,
    default: null,
  },
  to: {
    type: String,
    default: null,
  },
  provider: {
    type: String,
    enum: ["twilio", "qalqul"],
    //required: true,
  },
  startTime: {
    type: Date, // Date et heure de début de l'appel
    required: true,
  },
  endTime: {
    type: Date, // Date et heure de fin de l'appel
    default: null,
  },
  status: {
    type: String,
    //enum: ["active", "completed", "missed", "failed"],
    default: null,
  },
  duration: {
    type: Number,
    default: 0,
  },
  recording_url: String,
  recording_url_cloudinary: String,
  quality_score: {
    type: Number,
    min: 0,
    max: 100,
  },
  // ai_call_score rubric — each metric carries:
  //   • score    (0-100, raw quality)
  //   • feedback (LLM rationale)
  //   • passed   (boolean verdict — true when score ≥ 50; written by analyzer)
  //
  // `passed` is the canonical Yes/No used by dashboards and the rep modal.
  // Keeping it on the document avoids re-thresholding on every read.
  ai_call_score: {
    "Agent fluency": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "Sentiment analysis": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "Fraud detection": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "Script coherence": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "Argumentation": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "Script adherence": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "Transaction analysis": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "PAS INTÉRESSÉS": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "PAS AU COURANT": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "DÉJÀ ÉQUIPÉS": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "RDV": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "A plus tard": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "overall": {
      score:    { type: Number, min: 0, max: 100 },
      feedback: { type: String },
      feedback_fr: { type: String },
      feedback_en: { type: String },
      passed:   { type: Boolean, default: false }
    },
    "transaction_detected": { type: Boolean, default: false },
    "refusal_detected":     { type: Boolean, default: false }
  },
  transcript: [{
    speaker: String,
    text: String,
    timestamp: String
  }],
  childCalls: [String], // Liste des appels enfants (SID)
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Gig",
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  transactionOccurred: {
    type: Boolean,
    default: null,
  },
  validByAI: {
    type: Boolean,
    default: null,
  },
  valid: {
    type: Boolean,
    default: null,
  },
  /** Why the AI (or the auto-refusal rule) rejected the call. Used to display
   *  a meaningful badge in the frontend instead of just "Refusé AI". */
  ai_refusal_reason: {
    type: String,
    default: null,
  },
  argumentation_score: {
    type: Number,
    default: 0,
  },

  price: {
    type: Number,
    default: 0,
  },
  repCallCommission: {
    type: Number,
    default: 0,
  },
  platformCallCommission: {
    type: Number,
    default: 0,
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  Unified call-analysis layer (powers the company OperationsDashboard:
  //  Vue globale / Appels / Résultats / Équipe + the Leads "Rappels"
  //  block). All fields below are denormalised at analyze-time so dashboards
  //  can group/filter without re-scanning transcripts or nested AI rubrics.
  // ──────────────────────────────────────────────────────────────────────────

  /** Operational disposition of the call. Written by the AI analyzer; can
   *  optionally be overridden by the rep (see callOutcomeSource). Used for
   *  the Résultats donut, the per-rep matrix, and recent-call tags. */
  callOutcome: {
    type: String,
    enum: [
      'transaction',         // vente conclue
      'appointment',         // RDV fixé
      'callback_requested',  // rappel demandé (callbackAt set)
      'argued_interested',   // argumenté, intéressé mais pas signé
      'refusal',             // refus catégorique
      'not_interested',      // pas intéressé
      'already_equipped',    // déjà équipé (B2C/B2B concurrent)
      'voicemail',           // messagerie vocale
      'no_answer',           // pas de réponse
      'busy',                // occupé
      'wrong_number',        // numéro invalide
      'fraud',               // fraude détectée
      'too_short',           // <X sec, indécidable
      'connected_no_sale',   // connecté sans issue claire (fallback)
    ],
    default: null,
    index: true,
  },
  /** Who set callOutcome. "ai" by default, "rep" if a rep overrode it from
   *  the rep frontend, "system" for deterministic non-AI paths (auto-refus,
   *  voicemail detection, wrong-number from Twilio status, ...). */
  callOutcomeSource: {
    type: String,
    enum: ['ai', 'rep', 'system'],
    default: null,
  },
  /** Scheduled callback if the lead asked to be re-called. Drives the
   *  Leads view "À rappeler aujourd'hui / Cette semaine" KPI. */
  callbackAt: { type: Date, default: null, index: true },
  /** Confirmed appointment (RDV fixé). Drives the "RDV confirmés" KPI. */
  appointmentAt: { type: Date, default: null, index: true },

  /** Lifecycle of the AI analyzer for this call. Lets the UI show a real
   *  "Analyse en cours" state instead of inferring from validByAI == null. */
  ai_call_status: {
    type: String,
    enum: ['pending', 'processing', 'scored', 'auto_refused', 'error'],
    default: 'pending',
    index: true,
  },
  /** Short natural-language summary generated by the LLM (audioSummaryPrompt).
   *  Persisted so dashboards / search can use it without re-running the prompt. */
  ai_summary: { type: String, default: null },
  ai_summary_fr: { type: String, default: null },
  ai_summary_en: { type: String, default: null },

  /** Denormalised boolean flags for fast aggregation. Single source of truth
   *  for "fraude" / "sérieux" KPIs across the company dashboard — replaces
   *  the broken `ai_call_score.fraud_detected` lookup that lived in the
   *  frontend. */
  flags: {
    fraud:               { type: Boolean, default: false, index: true },
    serious:             { type: Boolean, default: false, index: true },
    transactionDetected: { type: Boolean, default: false },
    refusalDetected:     { type: Boolean, default: false },
  },

  /** Workflow validations — harmonised with v25_dashboard_backend so both
   *  services read/write the same fields and we stop drifting. */
  companyValidation: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  agentValidation: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

callSchema.virtual('transaction', {
  ref: 'Transaction',
  localField: '_id',
  foreignField: 'call',
  justOne: true
});

callSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Call = mongoose.model("Call", callSchema);

module.exports = { Call };
