const { SpeechClient } = require('@google-cloud/speech').v1p1beta1;
const { VertexAI } = require('@google-cloud/vertexai');

let speechClientConfig = {};
try {
  if (process.env.GCP_SPEECH_TO_TEXT_CREDENTIALS) {
    speechClientConfig.credentials = JSON.parse(process.env.GCP_SPEECH_TO_TEXT_CREDENTIALS);
    console.log('✅ [VertexAIService] Loaded Speech-to-Text credentials from env');
  }
} catch (e) {
  console.error('❌ [VertexAIService] Error parsing GCP_SPEECH_TO_TEXT_CREDENTIALS:', e);
}

const speechClient = new SpeechClient(speechClientConfig);

let vertexAIConfig = {
  project: process.env.GOOGLE_CLOUD_PROJECT || 'harx-technologies-inc',
  location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
};

try {
  if (process.env.VERTEX_AI_CREDENTIALS) {
    vertexAIConfig.credentials = JSON.parse(process.env.VERTEX_AI_CREDENTIALS);
    console.log('✅ [VertexAIService] Loaded VertexAI credentials from env');
  }
} catch (e) {
  console.error('❌ [VertexAIService] Error parsing VERTEX_AI_CREDENTIALS:', e);
}

const vertexAI = new VertexAI(vertexAIConfig);

const model = process.env.VERTEX_AI_MODEL || 'gemini-2.0-flash';

class VertexAIService {
  async createSpeechStream(config = {}) {
    console.log('🎤 [VertexAIService] Initializing speech stream with config:', JSON.stringify(config));
    // Configuration par défaut optimisée pour la téléphonie
    const defaultConfig = {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000, // Souvent 8k ou 16k pour la téléphonie
      languageCode: 'en-US',
      model: 'telephony', // Changé en 'telephony' pour une meilleure précision
      useEnhanced: true,
      enableAutomaticPunctuation: true,
      audioChannelCount: 1,
      enableWordConfidence: true,
      enableSpeakerDiarization: true, // Crucial pour distinguer Agent v Client
      diarizationConfig: {
        enableSpeakerDiarization: true,
        minSpeakerCount: 2,
        maxSpeakerCount: 2,
      },
    };

    // Clean up the config to avoid duplicate or misplaced fields
    const { interimResults, ...restConfig } = config;
    const finalSpeechConfig = { ...defaultConfig, ...restConfig };

    const request = {
      streamingConfig: {
        config: finalSpeechConfig,
        interimResults: interimResults !== undefined ? interimResults : true
      }
    };

    try {
      console.log('🎤 CREATING SPEECH STREAM with request:', JSON.stringify(request, null, 2));
      const recognizeStream = speechClient.streamingRecognize(request)
        .on('error', error => {
          if (error.code === 11 && error.message.includes('Audio Timeout Error')) {
            console.log('Audio stream timed out - this is normal when call ends');
            recognizeStream.destroy();
            return;
          }
          console.error('❌ Speech recognition error:', {
            code: error.code,
            message: error.message,
            details: error.details,
            metadata: error.metadata
          });
        });

      return recognizeStream;
    } catch (error) {
      console.error('Error creating speech stream:', error);
      throw error;
    }
  }

  async analyzeCallPhase(transcript) {
    try {
      const generativeModel = vertexAI.preview.getGenerativeModel({
        model: model,
        generation_config: {
          max_output_tokens: 512,
          temperature: 0.2, // Basse température pour la classification
          response_mime_type: 'application/json',
        },
      });

      const prompt = `You are an expert Sales Quality Assurance AI. Your task is to analyze a live call transcript between an agent and a customer.

Goal: Identify which phase of the 'REPS Call Flow' the conversation is currently in.

Phases to track:
- SBAM & Opening: Greeting, smiling voice, and stating the purpose.
- Legal & Compliance: Mentioning recording disclosures or privacy terms.
- Need Discovery: Asking open-ended questions to find pain points.
- Value Proposition: Explaining how the product solves the customer's specific needs.
- Objection Handling: Addressing concerns about price, timing, or competitors.
- Confirmation & Closing: Asking for the sale or scheduling the next step.

Output Format: Return ONLY a JSON object:
{"current_phase": "Phase Name", "confidence": 0-100, "next_step_suggestion": "Short tip for the agent"}

Transcript:
${transcript}`;

      console.log('🧠 Calling VertexAI for phase analysis... Prompt size:', prompt.length);
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const parsedResponse = JSON.parse(response.text());
      console.log('✅ VertexAI Response:', JSON.stringify(parsedResponse));
      return parsedResponse;
    } catch (error) {
      console.error('❌ Error in analyzeCallPhase:', error);
      return { current_phase: "Unknown", confidence: 0, next_step_suggestion: "Keep the conversation going" };
    }
  }

  async analyzeDiscovery(segment) {
    try {
      const generativeModel = vertexAI.preview.getGenerativeModel({
        model: model,
        generation_config: { temperature: 0.3 },
      });

      const prompt = `Analyze the following transcript segment. Has the agent identified at least three specific pain points?
If yes, list them. If no, suggest two diagnostic questions the agent should ask right now to uncover the customer's true budget and timeline.

Transcript:
${segment}`;

      const result = await generativeModel.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error('Error in analyzeDiscovery:', error);
      return null;
    }
  }

  async analyzeObjection(objection) {
    try {
      const generativeModel = vertexAI.preview.getGenerativeModel({
        model: model,
        generation_config: { temperature: 0.5 },
      });

      const prompt = `The customer just raised an objection regarding [Price/Complexity/Trust]. 
Using the Feel-Felt-Found technique, provide a 2-sentence script the agent can use immediately to pivot back to the Value Proposition.

Objection:
${objection}`;

      const result = await generativeModel.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error('Error in analyzeObjection:', error);
      return null;
    }
  }

  async generatePostCallSummary(fullTranscript) {
    try {
      const generativeModel = vertexAI.preview.getGenerativeModel({
        model: model,
        generation_config: { temperature: 0.2 },
      });

      const prompt = `Summarize this entire transcript into a CRM-ready format:
- Customer Mood: (Positive/Neutral/Negative)
- Key Requirements:
- Agreed Next Steps:
- Missing Compliance: (Did they miss the legal disclaimer? Yes/No)

Transcript:
${fullTranscript}`;

      const result = await generativeModel.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error('Error in generatePostCallSummary:', error);
      return "Summary unavailable.";
    }
  }

  async getAIAssistance(transcription, context = []) {
    // Keep legacy support or internal use
    try {
      const generativeModel = vertexAI.preview.getGenerativeModel({
        model: model,
        generation_config: {
          max_output_tokens: 256,
          temperature: 0.7,
        },
      });

      const chat = generativeModel.startChat({
        history: context.map(msg => ({
          role: msg.role === 'assistant' ? 'model' : msg.role,
          parts: [{ text: msg.content }]
        })),
      });

      const result = await chat.sendMessage(transcription);
      return result.response.text();
    } catch (error) {
      console.error('Error getting AI assistance:', error);
      throw error;
    }
  }
}

module.exports = new VertexAIService(); 