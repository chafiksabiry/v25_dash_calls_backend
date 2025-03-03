const twilio = require('twilio');

class TwilioService {
  constructor(accountSid, authToken) {
    this.client = twilio(accountSid, authToken);
  }

  async makeCall(to, from) {
    try {
      const call = await this.client.calls.create({
        to,
        from,
        url: 'http://demo.twilio.com/docs/voice.xml' // Replace with your TwiML URL
      });
      return call;
    } catch (error) {
      throw new Error(`Failed to make Twilio call: ${error.message}`);
    }
  }

  async sendSMS(to, from, body) {
    try {
      const message = await this.client.messages.create({
        to,
        from,
        body
      });
      return message;
    } catch (error) {
      throw new Error(`Failed to send Twilio SMS: ${error.message}`);
    }
  }

  async validateCredentials() {
    try {
      await this.client.api.accounts(this.client.accountSid).fetch();
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = { TwilioService };

export { TwilioService }