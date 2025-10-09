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

  /**
   * Generate a unique command ID
   * @returns {string} A unique command ID
   */
  generateCommandId() {
    return `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Initiate an outbound call using Telnyx
   * @param {string} to - The destination phone number
   * @param {string} from - The caller ID number
   * @param {string} agentId - The ID of the agent making the call
   * @returns {Promise<Object>} The call object
   */
  async makeCall(to, from, agentId) {
    try {
      // Validate phone numbers
      if (!to.startsWith('+')) {
        throw new Error('Destination number must be in E.164 format (e.g., +1234567890)');
      }

      const callOptions = {
        to: to,
        from: from,
        connection_id: this.applicationId,
        command_id: this.generateCommandId()
      };

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
        call_id: call.call_control_id // Telnyx's unique call identifier
      });

      return {
        callId: call.call_control_id,
        status: call.status,
        direction: call.direction,
        dbRecord: callRecord
      };

    } catch (error) {
      console.error('Error in TelnyxService.makeCall:', error.response?.data || error.message);
      throw new Error(`Failed to initiate Telnyx call: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
    }
  }

  /**
   * Handle call status webhook from Telnyx
   * @param {Object} event - The webhook event from Telnyx
   * @returns {Promise<Object>} Updated call record
   */
  async handleCallWebhook(event) {
    try {
      const callId = event.data.payload.call_control_id;
      const eventType = event.data.event_type;

      // Find the call in our database
      const call = await Call.findOne({ call_id: callId });
      if (!call) {
        throw new Error(`Call not found with ID: ${callId}`);
      }

      // Update call status based on event type
      switch (eventType) {
        case 'call.initiated':
          call.status = 'initiated';
          break;
        case 'call.answered':
          call.status = 'in-progress';
          call.startTime = new Date();
          break;
        case 'call.hangup':
        case 'call.terminated':
          call.status = 'completed';
          call.endTime = new Date();
          call.duration = Math.round((call.endTime - call.startTime) / 1000); // Duration in seconds
          break;
        case 'call.recording.saved':
          call.recording_url = event.data.payload.recording_urls.mp3;
          break;
      }

      await call.save();
      return call;

    } catch (error) {
      console.error('Error handling Telnyx webhook:', error);
      throw new Error(`Failed to process call webhook: ${error.message}`);
    }
  }

  /**
   * Mute a call
   * @param {string} callId - The call control ID
   * @returns {Promise<Object>} The call status
   */
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

  /**
   * Unmute a call
   * @param {string} callId - The call control ID
   * @returns {Promise<Object>} The call status
   */
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

  /**
   * End a call
   * @param {string} callId - The call control ID
   * @returns {Promise<Object>} The call status
   */
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