const { SpeechClient } = require('@google-cloud/speech').v1;
const { Call } = require('../models/Call');
const { SpeechClient: SpeechClientV2 } = require('@google-cloud/speech').v2;
const { VertexAI } = require('@google-cloud/vertexai');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { generatePrompt } = require('../VertexPrompt/contactCenterAssessment');
const { generateLanguagePrompt } = require('../VertexPrompt/languageAssessment');
const { generateAudioTranscriptionPrompt } = require('../VertexPrompt/audioTranscriptionPrompt');
const { Storage } = require('@google-cloud/storage');

let speechClient = null;
let speechClientV2 = null;
let vertexAI = null;
let generativeModel = null;
let storage = null;

const projectID = (process.env.GOOGLE_CLOUD_PROJECT || process.env.QAUTH2_PROJECT_ID || 'harx-technologies-inc').replace(/"/g, '');
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const modelName = process.env.VERTEX_AI_MODEL || 'gemini-2.0-flash';
const bucketName = process.env.GOOGLE_CLOUD_STORAGE_BUCKET || 'harx-audios-test';

let vertexCredentialsPath = null;
let speechCredentialsPath = null;
let storageCredentialsPath = null;

const setupGCPCredentials = async () => {
  const tempDir = path.join(__dirname, '../../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Vertex AI Credentials
  const vertexCreds = (process.env.VERTEX_AI_CREDENTIALS || process.env.GCP_VERTEX_AI_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (vertexCreds && vertexCreds.startsWith('{')) {
    vertexCredentialsPath = path.join(tempDir, 'vertex-credentials.json');
    await fsPromises.writeFile(vertexCredentialsPath, vertexCreds);
    console.log('✅ [VertexAIService] Using Vertex AI credentials from JSON env var');
  } else {
    vertexCredentialsPath = vertexCreds || path.join(__dirname, "../../config/vertex-service-account.json");
  }

  // Speech-to-Text Credentials
  const speechCreds = (process.env.GCP_SPEECH_TO_TEXT_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (speechCreds && speechCreds.startsWith('{')) {
    speechCredentialsPath = path.join(tempDir, 'speech-credentials.json');
    await fsPromises.writeFile(speechCredentialsPath, speechCreds);
    console.log('✅ [VertexAIService] Using Speech-to-Text credentials from JSON env var');
  } else {
    speechCredentialsPath = speechCreds || path.join(__dirname, "../../config/speech-to-text-service-account.json");
  }

  // Storage Credentials
  const storageCreds = (process.env.CLOUD_STORAGE_CREDENTIALS || process.env.GCP_STORAGE_CREDENTIALS || process.env.GCP_CLOUD_STORAGE_CREDENTIALS || vertexCreds).trim();
  if (storageCreds && storageCreds.startsWith('{')) {
    storageCredentialsPath = path.join(tempDir, 'storage-credentials.json');
    await fsPromises.writeFile(storageCredentialsPath, storageCreds);
    console.log('✅ [VertexAIService] Using Storage credentials from JSON env var');
  } else {
    storageCredentialsPath = storageCreds || path.join(__dirname, "../../config/cloud-storage-service-account.json");
  }
};

const initializeServices = async () => {
  if (vertexAI && speechClient) return;

  await setupGCPCredentials();

  const vertexAuthOptions = {
    keyFilename: vertexCredentialsPath,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  };

  vertexAI = new VertexAI({ project: projectID, location: location, googleAuthOptions: vertexAuthOptions });
  generativeModel = vertexAI.getGenerativeModel({
    model: modelName,
    generation_config: {
      max_output_tokens: 512,
      temperature: 0.2,
      response_mime_type: 'application/json',
    }
  });

  speechClient = new SpeechClient({ keyFilename: speechCredentialsPath });
  speechClientV2 = new SpeechClientV2({ keyFilename: speechCredentialsPath });

  storage = new Storage({
    projectId: projectID,
    keyFilename: storageCredentialsPath
  });

  console.log(`✅ [VertexAIService] Services initialized (Model: ${modelName}, Project: ${projectID})`);
};

const getSpeechClient = async () => {
  await initializeServices();
  return speechClient;
};

const getSpeechClientV2 = async () => {
  await initializeServices();
  return speechClientV2;
};

const getVertexAI = async () => {
  await initializeServices();
  return vertexAI;
};

const getGenerativeModel = async () => {
  await initializeServices();
  return generativeModel;
};

class VertexAIService {
  async getSpeechClient() {
    return await getSpeechClient();
  }

  async getSpeechClientV2() {
    return await getSpeechClientV2();
  }

  async getVertexAI() {
    return await getVertexAI();
  }

  async getGenerativeModel() {
    return await getGenerativeModel();
  }

  async createSpeechStream(config = {}) {
    console.log('🎤 [VertexAIService] RECEIVED CONFIG REQUEST:', JSON.stringify(config));

    // Minimal baseline configuration for raw PCM at 16kHz
    const defaultConfig = {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: 'en-US',
      alternativeLanguageCodes: ['fr-FR', 'ar-MA', 'ar-SA'],
      enableAutomaticLanguageIdentification: true,
      model: 'latest_long',
      useEnhanced: true,
      enableAutomaticPunctuation: true,
      metadata: {
        interactionType: 'PHONE_CALL',
        microphoneDistance: 'NEARFIELD',
        recordingDeviceType: 'SMARTPHONE',
      }
    };

    // Handle both flat config and nested { config: { ... } }
    const actualConfig = config.config || config;
    const { interimResults, ...incomingConfig } = actualConfig;

    // Build the clean config
    const cleanConfig = {};
    allowedFields.forEach(field => {
      // Priority: incomingConfig > defaultConfig
      if (incomingConfig[field] !== undefined) {
        cleanConfig[field] = incomingConfig[field];
      } else if (defaultConfig[field] !== undefined) {
        cleanConfig[field] = defaultConfig[field];
      }
    });

    // Special handling for languageCode (ensure it's never empty if required)
    if (!cleanConfig.languageCode) {
      cleanConfig.languageCode = defaultConfig.languageCode || 'en-US';
    }

    const request = {
      config: cleanConfig,
      interimResults: config.interimResults !== undefined ? config.interimResults : (interimResults !== undefined ? interimResults : true)
    };

    try {
      console.log('🎤 [VertexAIService] GOOGLE_CLOUD_REQUEST:', JSON.stringify(request, null, 2));
      const client = await getSpeechClient();
      const recognizeStream = client.streamingRecognize(request)
        .on('error', error => {
          if (error.code === 11 && error.message.includes('Audio Timeout Error')) {
            console.log('Audio stream timed out - this is normal when call ends');
            recognizeStream.destroy();
            return;
          }
          console.error('❌ Speech recognition stream error:', {
            code: error.code,
            message: error.message,
            details: error.details
          });
          // Important: destroy the stream to avoid leaks and prevent crash
          recognizeStream.destroy();
        });

      return recognizeStream;
    } catch (error) {
      console.error('Error creating speech stream:', error);
      throw error;
    }
  }

  async analyzeCallPhase(transcript) {
    try {
      const gModel = await getGenerativeModel();

      const prompt = `You are an expert multilingual Sales Quality Assurance AI. 
The live call transcript provided below may be in English, French, Arabic (including Moroccan Darija), or a mix of these.
The transcript differentiates speakers using labels like [Speaker 1] and [Speaker 2]. Usually, the Rep is the one initiating the call or asking questions.

Goal: Identify which phase of the 'REPS Call Flow' the conversation is currently in, regardless of the language used. Use speaker turns to determine who is talking.

Phases to track:
- SBAM & Opening: Greeting (e.g., "Hello", "Bonjour", "Salam"), smiling voice, and purpose.
- Legal & Compliance: Mentioning recording disclosures or privacy terms.
- Need Discovery: Asking questions to uncover needs or pain points.
- Value Proposition: Explaining how the product solves the customer's specific needs.
- Objection Handling: Addressing concerns about price, timing, or trust.
- Confirmation & Closing: Asking for the sale or scheduling the next step.

Output Format: Return ONLY a JSON object. The "next_step_suggestion" should be provided in the primary language used in the transcript.
{
  "current_phase": "Phase Name", 
  "confidence": 0-100, 
  "next_step_suggestion": "Short tip for the agent",
  "strengths": ["string"],
  "improvements": ["string"]
}

Transcript:
${transcript}`;

      console.log('🧠 [VertexAIService] Calling VertexAI for phase analysis...');
      const result = await gModel.generateContent(prompt);
      const response = result.response;

      const parsedResponse = this.parseJsonResponse(response.candidates[0].content.parts[0].text);
      console.log('✅ [VertexAIService] AI Analysis Result:', JSON.stringify(parsedResponse));
      return parsedResponse;
    } catch (error) {
      console.error('❌ [VertexAIService] Error in analyzeCallPhase:', error);
      return { current_phase: "Unknown", confidence: 0, next_step_suggestion: "Keep the conversation going" };
    }
  }

  async analyzeDiscovery(segment) {
    try {
      const gModel = await getGenerativeModel();
      const prompt = `Analyze the following transcript segment. Has the agent identified at least three specific pain points?
If yes, list them. If no, suggest two diagnostic questions the agent should ask right now to uncover the customer's true budget and timeline.

Transcript:
${segment}`;

      const result = await gModel.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error('Error in analyzeDiscovery:', error);
      return null;
    }
  }

  async analyzeObjection(objection) {
    try {
      const gModel = await getGenerativeModel();
      const prompt = `The customer just raised an objection regarding [Price/Complexity/Trust]. 
Using the Feel-Felt-Found technique, provide a 2-sentence script the agent can use immediately to pivot back to the Value Proposition.

Objection:
${objection}`;

      const result = await gModel.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error('Error in analyzeObjection:', error);
      return null;
    }
  }

  async generatePostCallSummary(fullTranscript) {
    try {
      const gModel = await getGenerativeModel();
      const prompt = `Summarize this entire transcript into a CRM-ready format:
- Customer Mood: (Positive/Neutral/Negative)
- Key Requirements:
- Agreed Next Steps:
- Missing Compliance: (Did they miss the legal disclaimer? Yes/No)

Transcript:
${fullTranscript}`;

      const result = await gModel.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error('Error in generatePostCallSummary:', error);
      return "Summary unavailable.";
    }
  }

  async evaluateRepLanguage(fileUri, textToCompare) {
    try {
      const gModel = await getGenerativeModel();
      const prompt = generateLanguagePrompt(textToCompare);

      const request = {
        contents: [{
          role: 'user', parts: [
            {
              "file_data": {
                "mime_type": "audio/linear16", // Adjusted for our PCM
                "file_uri": fileUri
              }
            },
            { "text": prompt }
          ]
        }],
      };

      const result = await gModel.generateContent(request);
      return this.parseJsonResponse(result.response.text());
    } catch (error) {
      console.error('Error in evaluateRepLanguage:', error);
      throw error;
    }
  }

  async evaluateRepCCSkills(fileUri, scenarioData) {
    try {
      const gModel = await getGenerativeModel();
      const prompt = generatePrompt(scenarioData);

      const request = {
        contents: [{
          role: 'user', parts: [
            {
              "file_data": {
                "mime_type": "audio/linear16",
                "file_uri": fileUri
              }
            },
            { "text": prompt }
          ]
        }],
      };

      const result = await gModel.generateContent(request);
      return this.parseJsonResponse(result.response.text());
    } catch (error) {
      console.error('Error in evaluateRepCCSkills:', error);
      throw error;
    }
  }

  async transcribeAudio(base64Audio, language = 'en-US') {
    try {
      const client = await getSpeechClient();
      const request = {
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          languageCode: language,
          enableAutomaticPunctuation: true,
        },
        audio: {
          content: base64Audio,
        },
      };

      const [response] = await client.recognize(request);
      return response;
    } catch (error) {
      console.error("❌ [VertexAIService] Error transcribing audio:", error.message);
      throw new Error("Short audio transcription failed");
    }
  }

  async transcribeAudioBuffer(audioBuffer) {
    try {
      const gModel = await getGenerativeModel();
      const prompt = generateAudioTranscriptionPrompt();

      // Convert raw PCM buffer to WAV format using helper (inline for now)
      const wavBuffer = this.pcmToWav(audioBuffer);
      const base64Audio = wavBuffer.toString('base64');

      const request = {
        contents: [{
          role: 'user', parts: [
            {
              "inline_data": {
                "mime_type": "audio/wav",
                "data": base64Audio
              }
            },
            { "text": prompt }
          ]
        }],
      };

      console.log(`🧠 [VertexAIService] Calling Gemini for transcription (chunk size: ${audioBuffer.length} bytes)`);
      const result = await gModel.generateContent(request);

      // DEBUG: Log the full structure to understand why .text() is missing
      // console.log("🔍 [VertexAIService] Full Gemini Result:", JSON.stringify(result, null, 2));

      let responseText = '';

      // Check if standard helper exists
      if (result.response && typeof result.response.text === 'function') {
        responseText = result.response.text();
      }
      // Fallback: Access candidates directly (common in some SDK versions or raw responses)
      else if (result.response && result.response.candidates && result.response.candidates.length > 0) {
        console.warn("⚠️ [VertexAIService] .text() function missing, extracting manually from candidates");
        const candidate = result.response.candidates[0];
        if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
          responseText = candidate.content.parts[0].text;
        }
      }
      else {
        console.error("❌ [VertexAIService] Invalid or empty response from Gemini:", JSON.stringify(result, null, 2));
        return [];
      }

      return this.parseJsonResponse(responseText);
    } catch (error) {
      console.error("❌ [VertexAIService] Error transcribing buffer with Gemini:", error);
      // Return empty array on error to prevent crashing caller
      return [];
    }
  }

  // Helper to add WAV header to raw PCM
  pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitDepth = 16) {
    const header = Buffer.alloc(44);
    const dataSize = pcmBuffer.length;
    const fileSize = dataSize + 36;
    const byteRate = sampleRate * numChannels * (bitDepth / 8);
    const blockAlign = numChannels * (bitDepth / 8);

    // RIFF chunk descriptor
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);

    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  async transcribeLongAudio(languageCode, fileUri) {
    try {
      const client = await getSpeechClient();
      const config = {
        encoding: "LINEAR16", // Standard for our PCM
        sampleRateHertz: 16000,
        languageCode: languageCode,
        enableAutomaticPunctuation: true,
      };

      const audio = {
        uri: fileUri, // gs:// format
      };

      const request = { config, audio };
      console.log("🚀 [VertexAIService] Starting long audio transcription for:", fileUri);

      const [operation] = await client.longRunningRecognize(request);
      const [response] = await operation.promise();

      const transcription = response.results
        .map(result => result.alternatives[0].transcript)
        .join("\n");

      console.log(`✅ [VertexAIService] Long transcription completed`);
      return transcription;
    } catch (error) {
      console.error("❌ [VertexAIService] Error transcribing long audio:", error);
      throw new Error("Long audio transcription failed");
    }
  }

  async audioUpload(filePath, destinationName) {
    try {
      await initializeServices();
      const options = { destination: destinationName };

      await storage.bucket(bucketName).upload(filePath, options);
      console.log(`✅ [VertexAIService] ${filePath} uploaded to ${bucketName} as ${destinationName}`);

      return {
        message: `${filePath} successfully uploaded to ${bucketName} as ${destinationName}`,
        bucketName,
        fileUri: `gs://${bucketName}/${destinationName}`,
      };
    } catch (error) {
      console.error(`❌ [VertexAIService] Storage upload failed:`, error);
      throw error;
    }
  }

  async audioUploadBuffer(fileBuffer, destinationName) {
    try {
      await initializeServices();
      const bucket = storage.bucket(bucketName);
      const file = bucket.file(destinationName);

      const stream = file.createWriteStream({ resumable: false });

      return new Promise((resolve, reject) => {
        stream.on('error', (error) => {
          console.error(`❌ [VertexAIService] Stream error during upload:`, error);
          reject(error);
        });

        stream.on('finish', () => {
          console.log(`✅ [VertexAIService] ${destinationName} uploaded to ${bucketName}`);
          resolve({
            message: `${destinationName} successfully uploaded to ${bucketName}`,
            bucketName,
            fileUri: `gs://${bucketName}/${destinationName}`,
          });
        });

        stream.end(fileBuffer);
      });
    } catch (error) {
      console.error(`❌ [VertexAIService] audioUploadBuffer failed:`, error);
      throw error;
    }
  }

  async getAIAssistance(transcription, context = []) {
    try {
      await initializeServices();

      const chat = generativeModel.startChat({
        history: context && Array.isArray(context) ? context.map(msg => ({
          role: msg.role === 'assistant' ? 'model' : msg.role,
          parts: [{ text: msg.content }]
        })) : [],
      });

      const result = await chat.sendMessage(transcription);
      return result.response.text();
    } catch (error) {
      console.error('❌ [VertexAIService] Error getting AI assistance:', error);
      throw error;
    }
  }

  async getPersonalityAnalysis(transcription, context = [], callDuration = 'Unknown') {
    try {
      await initializeServices();

      const isEarlyAnalysis = transcription.length < 100;
      const prompt = `You are an expert DISC personality analyst helping sales agents during phone calls.

      ${isEarlyAnalysis ? 'IMPORTANT: This is an early analysis with limited text. Focus on immediate personality indicators and provide a preliminary assessment.' : ''}

      Analyze the customer's communication patterns and provide DISC personality insights.
      
      Transcript: ${transcription}
      Duration: ${callDuration}

      Respond ONLY in JSON format:
      {
        "primaryType": "D|I|S|C",
        "secondaryType": "D|I|S|C|null",
        "confidence": 0-100,
        "recommendations": ["string"],
        "approachStrategy": "string",
        "communicationStyle": "string"
      }`;

      const result = await generativeModel.generateContent(prompt);
      const responseText = result.response.candidates[0].content.parts[0].text;

      return this.parseJsonResponse(responseText);
    } catch (error) {
      console.error('❌ [VertexAIService] Error in getPersonalityAnalysis:', error);
      throw error;
    }
  }

  // Alias for Gemini-based transcription (Knowledge Base logic)
  async getTranscription(audioBuffer) {
    return await this.transcribeAudioBuffer(audioBuffer);
  }

  async getCallTranscription(callId) {
    try {
      const call = await Call.findById(callId);
      if (!call) throw new Error('Call not found');

      // logic to get transcription (simulation or Gemini)
      // If we already have one stored or a recording URL
      if (call.recording_url) {
        // Here we could download and transcribe, but for now let's use the stored one or a placeholder logic
        // For "KB logic", we'd use transcribeAudioBuffer with the audio data
        // For simplicity, let's return stored transcript if any, or generate a dummy one
        return call.transcript || [];
      }
      return [];
    } catch (error) {
      console.error('Error in getCallTranscription:', error);
      throw error;
    }
  }

  async getCallSummary(callId) {
    try {
      const call = await Call.findById(callId);
      if (!call) throw new Error('Call not found');
      // Similar to summary logic already present
      return { summary: call.summary || 'No summary available.' };
    } catch (error) {
      console.error('Error in getCallSummary:', error);
      throw error;
    }
  }

  async getCallScoring(callId) {
    try {
      return {
        score: 85,
        breakdown: { clarity: 90, empathy: 80, assertiveness: 85 }
      };
    } catch (error) {
      throw error;
    }
  }

  async getCallPostActions(callId) {
    return {
      actions: [
        { task: 'Follow up email', priority: 'high' },
        { task: 'Update CRM', priority: 'medium' }
      ]
    };
  }

  // --- Helper Methods ---

  parseJsonResponse(responseText) {
    try {
      // Direct parse attempt
      if (responseText.trim().startsWith('{')) {
        return JSON.parse(responseText);
      }

      // Extraction from markdown code blocks
      const match = responseText.match(/```json\s*([\s\S]*?)\s*```/) ||
        responseText.match(/\{[\s\S]*\}/);

      if (match) {
        const jsonStr = match[1] || match[0];
        return JSON.parse(jsonStr.trim());
      }

      throw new Error("No JSON structure found in response");
    } catch (e) {
      console.error('⚠️ [VertexAIService] JSON Parse failed, returning raw text wrap:', e.message);
      return { raw_response: responseText };
    }
  }
}

module.exports = new VertexAIService(); 