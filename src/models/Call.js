/* const mongoose = require("mongoose");

const callSchema = new mongoose.Schema({
  _id: mongoose.Schema.Types.ObjectId, // Identifiant unique du call
  sid: {
    type: String,
    required: true,
    unique: true, // Identifiant Twilio de l'appel
  },
  parentCallSid: {
    type: String,
    default: null, // SID de l'appel parent s'il y en a un
  },
  childCalls: [
    {
      type: String, // Liste des identifiants des appels enfants
    },
  ],
  agent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Agent",
    required: true,
  },
  lead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Lead",
  },
  from: {
    type: String,
    required: true, // Numéro ou ID de l’appelant
  },
  to: {
    type: String,
    required: true, // Numéro ou ID du destinataire
  },
  direction: {
    type: String,
    enum: ["inbound", "outbound"],
    required: true,
  },
  status: {
    type: String,
    enum: ["active", "completed", "missed", "failed"],
    default: "active",
  },
  startTime: {
    type: Date,
  },
  endTime: {
    type: Date,
  },
  duration: {
    type: Number,
    default: 0, // Durée de l’appel en secondes
  },
  queueTime: {
    type: Number,
    default: 0, // Temps passé en attente (s’il y en a)
  },
  recording_url: String,
  quality_score: {
    type: Number,
    min: 0,
    max: 100,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Met à jour automatiquement la date de modification
callSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Call = mongoose.model("Call", callSchema);
module.exports = { Call };
 */
const mongoose = require("mongoose");

const callSchema = new mongoose.Schema({
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
    required: true,
    unique: true, // Identifiant Twilio de l'appel
  },
  parentCallSid: {
    type: String,
    default: null, // SID de l'appel parent s'il y en a un
  },
  direction: {
    type: String,
    enum: ["inbound", "outbound-dial"],
    required: true,
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
  ai_call_score: {
    "Agent fluency": {
      score: { type: Number, min: 0, max: 100 },
      feedback: { type: String }
    },
    "Sentiment analysis": {
      score: { type: Number, min: 0, max: 100 },
      feedback: { type: String }
    },
    "Fraud detection": {
      score: { type: Number, min: 0, max: 100 },
      feedback: { type: String }
    },
    "overall": {
      score: { type: Number, min: 0, max: 100 },
      feedback: { type: String }
    }
  },
  childCalls: [String], // Liste des appels enfants (SID)
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

callSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Call = mongoose.model("Call", callSchema);

module.exports = { Call };
