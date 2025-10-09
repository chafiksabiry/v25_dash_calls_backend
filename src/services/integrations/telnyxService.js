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

      // Générer un ID unique pour ce stream
      const streamId = this.generateCommandId();
      const baseUrl = process.env.BASE_URL || 'http://localhost:5006';

      // Créer un objet d'état client et le convertir en base64
      const clientState = Buffer.from(JSON.stringify({
        streamId,
        agentId,
        timestamp: new Date().toISOString()
      })).toString('base64');

      // Configuration selon la documentation Telnyx
      const callOptions = {
        // Paramètres requis
        to: to,
        from: from,
        connection_id: this.applicationId,
        
        // Identifiants uniques
        command_id: this.generateCommandId(),
        client_state: clientState,

        // Configuration de l'appel
        answer_on_bridge: true,              // Répondre seulement quand l'appel est connecté
        from_display_name: 'Harx Call',      // Nom affiché
        timeout_secs: 30,                    // Timeout de l'appel
        
        // Configuration du streaming
        stream_url: `${baseUrl}/audio-stream?callId=${streamId}`,
        stream_track: "both_tracks",         // Capturer l'audio dans les deux sens
        
        // Webhook pour les événements
       /*  webhook_url: process.env.WEBHOOK_URL,
        webhook_url_method: 'POST', */

        // Paramètres audio
        sip_headers: [],                     // En-têtes SIP personnalisés
        media_format: "pcm_s16le",          // Format audio non compressé
        channels: 1,                         // Mono
        sample_rate: 8000,                   // Taux d'échantillonnage standard
        
        // Désactiver les fonctionnalités non nécessaires
        answering_machine_detection: false,   // Pas de détection de répondeur
      };

      console.log('📞 Initiating call with config:', {
        to: to,
        from: from,
        streamId: streamId,
        streamUrl: callOptions.stream_url
      });

      // Create call using Telnyx API
      const response = await this.axiosInstance.post('/calls', callOptions);
      const call = response.data.data;

      // Create call record in database
      const callRecord = await Call.create({
        agent: agentId,
        direction: 'outbound-dial',
        provider: 'telnyx',
        startTime: new Date(),
        status: 'initiated',
        call_id: call.call_control_id,
        stream_id: streamId,
        stream_url: callOptions.stream_url
      });

      return {
        callId: call.call_control_id,
        streamId: streamId,
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
          break;
        case 'streaming.started':
          call.stream_status = 'active';
          console.log(`🎵 Streaming started for call ${callId}, stream ${clientState.streamId}`);
          break;
        case 'streaming.failed':
          call.stream_status = 'failed';
          call.stream_error = event.data.payload.error;
          console.error(`❌ Streaming failed for call ${callId}:`, event.data.payload.error);
          break;
        case 'streaming.stopped':
          call.stream_status = 'stopped';
          console.log(`🔇 Streaming stopped for call ${callId}`);
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
      const response = await this.axiosInstance.post(`/calls/${callId}/actions/hangup`, {
        command_id: this.generateCommandId()
      });
      
      const call = await Call.findOne({ call_id: callId });
      if (call) {
        call.status = 'completed';
        call.endTime = new Date();
        call.duration = Math.round((call.endTime - call.startTime) / 1000);
        await call.save();
      }

      return { success: true, message: 'Call ended successfully', data: response.data };
    } catch (error) {
      console.error('Error ending Telnyx call:', error.response?.data || error.message);
      throw new Error(`Failed to end call: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
    }
  }
}

module.exports = new TelnyxService();