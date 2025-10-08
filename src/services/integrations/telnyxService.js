
const telnyx = require('telnyx');
const { Call } = require('../../models/Call');

class TelnyxService {
  constructor() {
    this.client = telnyx(process.env.TELNYX_API_KEY);
    this.applicationId = process.env.TELNYX_APPLICATION_ID;
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
        webhook_url: process.env.TELNYX_WEBHOOK_URL,
        record_audio: false, // Disable call recording as per requirement
        timeout_secs: 30
      };

      // Create call using Telnyx API
      const call = await this.client.calls.create(callOptions);

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
      console.error('Error in TelnyxService.makeCall:', error);
      throw new Error(`Failed to initiate Telnyx call: ${error.message}`);
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
   * End an active call
   * @param {string} callId - The Telnyx call control ID
   * @returns {Promise<Object>} The call status
   */
  /**
   * Mute a call
   * @param {string} callId - The call control ID
   * @returns {Promise<Object>} The call status
   */
  async muteCall(callId) {
    try {
      await this.client.calls.mute(callId);
      return { success: true, message: 'Call muted successfully' };
    } catch (error) {
      console.error('Error muting Telnyx call:', error);
      throw new Error(`Failed to mute call: ${error.message}`);
    }
  }

  /**
   * Unmute a call
   * @param {string} callId - The call control ID
   * @returns {Promise<Object>} The call status
   */
  async unmuteCall(callId) {
    try {
      await this.client.calls.unmute(callId);
      return { success: true, message: 'Call unmuted successfully' };
    } catch (error) {
      console.error('Error unmuting Telnyx call:', error);
      throw new Error(`Failed to unmute call: ${error.message}`);
    }
  }

  async endCall(callId) {
    try {
      await this.client.calls.hangup(callId);
      
      const call = await Call.findOne({ call_id: callId });
      if (call) {
        call.status = 'completed';
        call.endTime = new Date();
        call.duration = Math.round((call.endTime - call.startTime) / 1000);
        await call.save();
      }

      return { success: true, message: 'Call ended successfully' };
    } catch (error) {
      console.error('Error ending Telnyx call:', error);
      throw new Error(`Failed to end call: ${error.message}`);
    }
  }
}

module.exports = new TelnyxService();

 