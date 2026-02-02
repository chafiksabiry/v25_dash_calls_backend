const mongoose = require('mongoose');

// Language Assessment Results Schema
const languageAssessmentResultsSchema = new mongoose.Schema({
  completeness: {
    score: { type: Number, min: 0, max: 100 },
    feedback: String
  },
  fluency: {
    score: { type: Number, min: 0, max: 100 },
    feedback: String
  },
  proficiency: {
    score: { type: Number, min: 0, max: 100 },
    feedback: String
  },
  overall: {
    score: { type: Number, min: 0, max: 100 },
    strengths: String,
    areasForImprovement: String
  },
  completedAt: { type: Date, default: Date.now }
}, { _id: false });

// Contact Center Assessment Schema
const contactCenterAssessmentSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    enum: ['Communication', 'Problem Solving', 'Customer Service']
  },
  skill: {
    type: String,
    required: true
  },
  score: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  strengths: [{
    type: String,
    required: true
  }],
  improvements: [{
    type: String,
    required: true
  }],
  feedback: {
    type: String,
    required: true
  },
  tips: [{
    type: String,
    required: true
  }],
  keyMetrics: {
    professionalism: {
      type: Number,
      required: true,
      min: 0,
      max: 10
    },
    effectiveness: {
      type: Number,
      required: true,
      min: 0,
      max: 10
    },
    customerFocus: {
      type: Number,
      required: true,
      min: 0,
      max: 10
    }
  },
  completedAt: {
    type: Date,
    default: Date.now
  }
});

const languageSchema = new mongoose.Schema({
  language: { type: String, required: true },
  proficiency: { type: String, required: true },
  assessmentResults: languageAssessmentResultsSchema
});

const skillSchema = new mongoose.Schema({
  skill: { type: String, required: true }, // Changed from 'name'
  level: { type: Number, required: true },
  details: String // Changed from 'context'
});

const achievementSchema = new mongoose.Schema({
  description: { type: String, required: true },
  impact: { type: String },
  context: { type: String },
  skills: [String]
});

const experienceSchema = new mongoose.Schema({
  title: { type: String, required: true },
  company: { type: String, required: true },
  startDate: { type: String, required: true },
  endDate: String,
  responsibilities: [{ type: String }],
  achievements: [{ type: String }]
});

const profileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['draft', 'in_progress', 'completed'],
    default: 'draft'
  },
  completionSteps: {
    basicInfo: { type: Boolean, default: false },
    experience: { type: Boolean, default: false },
    skills: { type: Boolean, default: false },
    languages: { type: Boolean, default: false },
    assessment: { type: Boolean, default: false }
  },
  personalInfo: {
    name: String,
    location: String,
    email: String,
    phone: String,
    languages: [languageSchema]
  },
  professionalSummary: {
    yearsOfExperience: String,
    currentRole: String,
    industries: [String],
    keyExpertise: [String],
    notableCompanies: [String],
    generatedSummary: String
  },
  skills: {
    technical: [skillSchema],
    professional: [skillSchema],
    soft: [skillSchema]
  },
  achievements: [achievementSchema],
  experience: [experienceSchema],
  assessments: {
    contactCenter: [contactCenterAssessmentSchema]
  },
  lastUpdated: { type: Date, default: Date.now }
}, { timestamps: true });

// Update lastUpdated timestamp on save
profileSchema.pre('save', function (next) {
  this.lastUpdated = new Date();
  next();
});

// Method to update completion status
profileSchema.methods.updateCompletionStatus = function () {
  const steps = this.completionSteps;

  // Update individual step completion status
  steps.basicInfo = !!(this.personalInfo.name && this.personalInfo.email);
  steps.experience = this.experience.length > 0;
  steps.skills = !!(this.skills.technical.length || this.skills.professional.length || this.skills.soft.length);
  steps.languages = this.personalInfo.languages.length > 0;
  steps.assessment = this.personalInfo.languages.some(lang => lang.assessmentResults) ||
    this.assessments.contactCenter.length > 0;

  // Update overall status
  const completedSteps = Object.values(steps).filter(Boolean).length;
  if (completedSteps === 0) {
    this.status = 'draft';
  } else if (completedSteps === Object.keys(steps).length) {
    this.status = 'completed';
  } else {
    this.status = 'in_progress';
  }
};

module.exports = mongoose.model('Agent', profileSchema);