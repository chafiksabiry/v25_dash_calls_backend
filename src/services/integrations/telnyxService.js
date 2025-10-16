const axios = require('axios');
const { Call } = require('../../models/Call');
require('dotenv').config();

class TelnyxService {
  constructor() {
    this.apiKey = process.env.TELNYX_API_KEY;
    this.applicationId = process.env.TELNYX_APPLICATION_ID;
    this.baseURL = 'https://api.telnyx.com/v2';
    this.axiosInstance = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
  }

  generateCommandId() {
    return `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async makeCall(to, from, agentId) {
    try {
      if (!to.startsWith('+')) {
        throw new Error('Destination number must be in E.164 format (e.g., +1234567890)');
      }

      // Créer un objet d'état client et le convertir en base64
      const clientState = Buffer.from(JSON.stringify({
        agentId,
        timestamp: new Date().toISOString()
      })).toString('base64');

      // Configuration exacte selon la documentation Telnyx
      const callOptions = {
        connection_id: this.applicationId,
        to: to,
        from: from,
        // Utiliser l'URL ngrok pour le streaming
        stream_url: 'wss://'+process.env.TELNYX_STREAM_URL+'/audio-stream',
        stream_track: 'both_tracks',           // Écouter les deux côtés de la conversation
        stream_bidirectional_mode: 'rtp', 
        stream_codec: 'PCMU',  // Changé de PCMU à OPUS
        stream_sample_rate: '8000', 
        stream_bidirectional_codec: 'PCMU',    // Utiliser PCMU pour une meilleure compatibilité
        stream_bidirectional_sample_rate: 8000,  // Fréquence standard pour PCMU
        client_state: clientState,
        command_id: this.generateCommandId()
      };

      console.log('📞 Initiating call with config:', {
        to: to,
        from: from,
        stream_url: callOptions.stream_url,
        stream_track: callOptions.stream_track,
        stream_bidirectional_codec: callOptions.stream_bidirectional_codec
      });

      // Create call using Telnyx API
      const response = await this.axiosInstance.post('/calls', callOptions);
      const call = response.data.data;

      // Activer la suppression de bruit immédiatement après la création de l'appel
      try {
        await this.axiosInstance.post(`/calls/${call.call_control_id}/actions/suppression_start`, {
          direction: 'both'  // Supprimer le bruit dans les deux sens
        });
        console.log('✅ Noise suppression enabled for call:', call.call_control_id);
      } catch (suppressionError) {
        console.error('❌ Failed to enable noise suppression:', suppressionError);
      }

      // Create call record in database
      const callRecord = await Call.create({
        agent: agentId,
        direction: 'outbound-dial',
        provider: 'telnyx',
        startTime: new Date(),
        status: 'initiated',
        call_id: call.call_control_id,
        stream_url: callOptions.stream_url
      });

      return {
        callId: call.call_control_id,
        status: call.status,
        direction: call.direction,
        streamUrl: callOptions.stream_url,
        dbRecord: callRecord
      };

    } catch (error) {
      console.error('Error in TelnyxService.makeCall:', error.response?.data || error.message);
      throw new Error(`Failed to initiate Telnyx call: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
    }
  }

  async handleCallWebhook(event) {
    try {
      const callId = event.data.payload.call_control_id;
      const eventType = event.data.event_type;
      
      // Décoder le client_state base64 si présent
      let clientState = {};
      if (event.data.payload.client_state) {
        try {
          const decodedState = Buffer.from(event.data.payload.client_state, 'base64').toString();
          clientState = JSON.parse(decodedState);
        } catch (error) {
          console.error('Error decoding client_state:', error);
        }
      }

      // Find the call in our database
      const call = await Call.findOne({ call_id: callId });
      if (!call) {
        throw new Error(`Call not found with ID: ${callId}`);
      }

      // Update call status based on event type
      switch (eventType) {
        case 'call.initiated':
          call.status = 'initiated';
          console.log(`📞 Call initiated: ${callId}`);
          break;
        case 'call.answered':
          call.status = 'in-progress';
          call.startTime = new Date();
          console.log(`📞 Call answered: ${callId}`);
          break;
        case 'call.hangup':
        case 'call.terminated':
          call.status = 'completed';
          call.endTime = new Date();
          call.duration = Math.round((call.endTime - call.startTime) / 1000);
          console.log(`📞 Call ended: ${callId}, duration: ${call.duration}s`);
          
          // Arrêter la suppression de bruit
          try {
            await this.axiosInstance.post(`/calls/${callId}/actions/suppression_stop`, {});
            console.log('✅ Noise suppression disabled for terminated call:', callId);
          } catch (suppressionError) {
            console.error('❌ Failed to disable noise suppression on call termination:', suppressionError);
          }
          break;
        case 'streaming.started':
          call.stream_status = 'active';
          console.log(`🎵 Streaming started for call ${callId}`, event.data.payload);
          break;
        case 'streaming.failed':
          call.stream_status = 'failed';
          call.stream_error = event.data.payload.failure_reason;
          console.error(`❌ Streaming failed for call ${callId}:`, event.data.payload);
          break;
        case 'streaming.stopped':
          call.stream_status = 'stopped';
          console.log(`🔇 Streaming stopped for call ${callId}`, event.data.payload);
          break;
      }

      await call.save();
      return call;

    } catch (error) {
      console.error('Error handling Telnyx webhook:', error);
      throw new Error(`Failed to process call webhook: ${error.message}`);
    }
  }

  async muteCall(callId) {
    try {
      const response = await this.axiosInstance.post(`/calls/${callId}/actions/mute`, {
        command_id: this.generateCommandId()
      });

      return { success: true, message: 'Call muted successfully', data: response.data };
    } catch (error) {
      console.error('Error muting Telnyx call:', error.response?.data || error.message);
      throw new Error(`Failed to mute call: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
    }
  }

  async unmuteCall(callId) {
    try {
      const response = await this.axiosInstance.post(`/calls/${callId}/actions/unmute`, {
        command_id: this.generateCommandId()
      });

      return { success: true, message: 'Call unmuted successfully', data: response.data };
    } catch (error) {
      console.error('Error unmuting Telnyx call:', error.response?.data || error.message);
      throw new Error(`Failed to unmute call: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
    }
  }

  async endCall(callId) {
    try {
      console.log('Attempting to end call:', callId);
      
      // D'abord, arrêter la suppression de bruit
      try {
        await this.axiosInstance.post(`/calls/${callId}/actions/suppression_stop`, {});
        console.log('✅ Noise suppression disabled for call:', callId);
      } catch (suppressionError) {
        console.error('❌ Failed to disable noise suppression:', suppressionError);
      }
      
      // Ensuite, terminer l'appel
      const url = `/calls/${callId}/actions/hangup`;
      console.log('Making request to:', url);
      
      const response = await this.axiosInstance.post(url);
      
      console.log('Telnyx API response:', response.data);
      return response.data;
    } catch (error) {
      console.error('Error ending Telnyx call:', error.response?.data || error.message);
      throw new Error(`Failed to end call: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
    }
  }

  async makeTestCall(to, from, streamConfig) {
    try {
      if (!to.startsWith('+')) {
        throw new Error('Destination number must be in E.164 format (e.g., +1234567890)');
      }

      // Configuration exacte pour le test
      const callOptions = {
        connection_id: this.applicationId,
        to: to,
        from: from,
        stream_url: streamConfig.streamUrl,
        stream_track: 'inbound_track',
        stream_codec: streamConfig.streamCodec || 'PCMU',
        stream_sample_rate: streamConfig.streamSampleRate || '8000',
        command_id: this.generateCommandId()
      };

      console.log('📞 Initiating test call with config:', {
        to: to,
        from: from,
        stream_url: callOptions.stream_url,
        stream_track: callOptions.stream_track,
        stream_codec: callOptions.stream_codec,
        stream_sample_rate: callOptions.stream_sample_rate
      });

      // Create call using Telnyx API
      const response = await this.axiosInstance.post('/calls', callOptions);
      const call = response.data.data;

      // Activer la suppression de bruit pour l'appel test
      try {
        await this.axiosInstance.post(`/calls/${call.call_control_id}/actions/suppression_start`, {
          direction: 'both',  // Supprimer le bruit dans les deux sens
          command_id: this.generateCommandId()
        });
        console.log('✅ Noise suppression enabled for test call:', call.call_control_id);
      } catch (suppressionError) {
        console.error('❌ Failed to enable noise suppression for test call:', suppressionError);
      }

      return {
        callId: call.call_control_id,
        status: call.status,
        direction: call.direction,
        streamUrl: callOptions.stream_url
      };

    } catch (error) {
      console.error('Error in TelnyxService.makeTestCall:', error.response?.data || error.message);
      throw new Error(`Failed to initiate test call: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
    }
  }
}

module.exports = new TelnyxService();