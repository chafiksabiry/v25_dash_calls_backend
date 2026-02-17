


const mongoose = require("mongoose");

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
