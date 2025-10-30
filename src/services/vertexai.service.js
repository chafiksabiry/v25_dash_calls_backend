const { SpeechClient } = require('@google-cloud/speech').v1p1beta1;
const { VertexAI } = require('@google-cloud/vertexai');

const speechClient = new SpeechClient();
const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION,
});

const model = 'gemini-pro';

class VertexAIService {
  async createSpeechStream(config = {}) {
    // Configuration par défaut avec français forcé
    const defaultConfig = {
      encoding: 'LINEAR16',
      sampleRateHertz: 48000,
      languageCode: 'en-US', // Langue par défaut
      model: 'default',
      useEnhanced: true,
      enableAutomaticPunctuation: true,
      audioChannelCount: 1,
      enableWordConfidence: true,
      enableSpeakerDiarization: true,
      enableAutomaticLanguageIdentification: false, // Désactiver la détection automatique
      alternativeLanguageCodes: [] // Pas d'alternatives pour forcer le français
    };

    // Fusionner avec la configuration fournie
    const request = {
      config: { ...defaultConfig, ...config },
      interimResults: true
    };

    try {
      console.log('🎤 CREATING SPEECH STREAM:');
      console.log('📥 Config received from frontend:', JSON.stringify(config, null, 2));
      console.log('🔧 Default config:', JSON.stringify(defaultConfig, null, 2));
      console.log('✅ Final merged config:', JSON.stringify(request.config, null, 2));
      console.log('🌍 Final language code:', request.config.languageCode);
      
      const recognizeStream = speechClient.streamingRecognize(request)
        .on('error', error => {
          // Check if it's a timeout error
          if (error.code === 11 && error.message.includes('Audio Timeout Error')) {
            console.log('Audio stream timed out - this is normal when call ends');
            recognizeStream.destroy();
            return;
          }
          console.error('Speech recognition error:', error);
        })
        .on('data', (data) => {
          console.log('Raw recognition data:', JSON.stringify(data, null, 2));
          
          if (data.results && data.results[0]) {
            const result = {
              transcript: data.results[0].alternatives[0]?.transcript || '',
              confidence: data.results[0].alternatives[0]?.confidence || 0,
              isFinal: data.results[0].isFinal,
              stability: data.results[0].stability,
              resultEndTime: data.results[0].resultEndTime,
              languageCode: data.results[0].languageCode || request.config.languageCode
            };
            console.log('Processed transcript:', result);
            return result;
          } else {
            console.log('No results in recognition data');
          }
        });

      recognizeStream.on('finish', () => {
        console.log('Recognition stream finished normally');
      });

      recognizeStream.on('close', () => {
        console.log('Recognition stream closed');
      });

      recognizeStream.on('end', () => {
        console.log('Recognition stream ended');
      });

      return recognizeStream;
    } catch (error) {
      console.error('Error creating speech stream:', error);
      throw error;
    }
  }

  async getAIAssistance(transcription, context = []) {
    try {
      const generativeModel = vertexAI.preview.getGenerativeModel({
        model: model,
        generation_config: {
          max_output_tokens: 256,
          temperature: 0.7,
        },
      });

      const chat = generativeModel.startChat({
        history: [
          ...context.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : msg.role,
            text: msg.content
          })),
          {
            role: 'user',
            text: `You are an AI assistant helping a call center agent during a live call. 
            Your role is to:
            1. Analyze customer sentiment and needs
            2. Suggest appropriate responses
            3. Provide relevant product/service information
            4. Help maintain professional communication
            Keep responses brief and actionable.
            
            Current conversation context: ${transcription}`
          }
        ],
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