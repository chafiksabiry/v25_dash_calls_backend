/* const ovh = require('ovh');

class OVHService {
  constructor(applicationKey, applicationSecret, consumerKey, endpoint = 'ovh-eu') {
    this.client = ovh({
      appKey: applicationKey,
      appSecret: applicationSecret,
      consumerKey: consumerKey,
      endpoint: endpoint
    });
  }

  async makeCall(to, from) {
    try {
      const call = await this.client.requestPromised('POST', '/telephony/line/calls', {
        to,
        from,
        type: 'voice'
      });
      return call;
    } catch (error) {
      throw new Error(`Failed to make OVH call: ${error.message}`);
    }
  }

  async sendSMS(to, from, body) {
    try {
      const message = await this.client.requestPromised('POST', '/sms/message', {
        receiver: to,
        sender: from,
        message: body
      });
      return message;
    } catch (error) {
      throw new Error(`Failed to send OVH SMS: ${error.message}`);
    }
  }

  async validateCredentials() {
    try {
      // Test the credentials by attempting to get account info
      await this.client.requestPromised('GET', '/me');
      return true;
    } catch (error) {
      return false;
    }
  }

  async getPhoneNumbers() {
    try {
      const numbers = await this.client.requestPromised('GET', '/telephony/number');
      return numbers;
    } catch (error) {
      throw new Error(`Failed to get OVH phone numbers: ${error.message}`);
    }
  }

  async getCallHistory(lineNumber, fromDate, toDate) {
    try {
      const params = {};
      if (fromDate) params.fromDate = fromDate;
      if (toDate) params.toDate = toDate;

      const calls = await this.client.requestPromised('GET', `/telephony/${lineNumber}/calls`, params);
      return calls;
    } catch (error) {
      throw new Error(`Failed to get OVH call history: ${error.message}`);
    }
  }

  async getLineStatus(lineNumber) {
    try {
      const status = await this.client.requestPromised('GET', `/telephony/${lineNumber}/status`);
      return status;
    } catch (error) {
      throw new Error(`Failed to get OVH line status: ${error.message}`);
    }
  }
}

module.exports = { OVHService };

 */
const ovh = require('ovh');
const axios = require('axios');
require('dotenv').config();

class OVHService {
  constructor(applicationKey, applicationSecret, consumerKey, endpoint = 'ovh-eu') {
    this.applicationKey = applicationKey;
    this.applicationSecret = applicationSecret;
    this.endpoint = endpoint;
    this.consumerKey = consumerKey;
  }

  async initializeClient() {
    if (!this.consumerKey) {
      this.consumerKey = await this.getOrCreateConsumerKey();
    }

    this.client = ovh({
      appKey: this.applicationKey,
      appSecret: this.applicationSecret,
      consumerKey: this.consumerKey,
      endpoint: this.endpoint
    });
  }

  async getOrCreateConsumerKey() {
    try {
      // Vérifier si la consumerKey est déjà définie dans .env
      if (process.env.OVH_CONSUMER_KEY) {
        console.log('Utilisation de la consumerKey depuis .env');
        return process.env.OVH_CONSUMER_KEY;
      }

      // Définir les permissions nécessaires
      const rights = [
        {
          method: 'GET',
          path: '/telephony/*'
        },
        {
          method: 'POST',
          path: '/telephony/*'
        }
      ];

      // Faire une requête pour générer la consumerKey
      const response = await axios.post(`https://eu.api.ovh.com/1.0/auth/credential`, {
        accessRules: rights,
        redirectUrl: 'https://www.example.com' // Peut être changé ou laissé vide
      }, {
        headers: {
          'X-Ovh-Application': this.applicationKey,
          'Content-Type': 'application/json'
        }
      });

      const credential = response.data;

      console.log('Consumer Key générée :', credential.consumerKey);
      console.log('Validez l\'autorisation ici :', credential.validationUrl);

      console.log('Veuillez valider cette clé en visitant le lien ci-dessus, puis ajoutez la clé dans votre fichier .env :');
      console.log(`OVH_CONSUMER_KEY=${credential.consumerKey}`);

      throw new Error('Validez la consumerKey puis redémarrez le serveur.');
    } catch (error) {
      throw new Error(`Échec de la génération de la consumerKey : ${error.message}`);
    }
  }

  async makeCall(to, from) {
    await this.initializeClient();
    try {
      const call = await this.client.requestPromised('POST', '/telephony/line/calls', {
        to,
        from,
        type: 'voice'
      });
      return call;
    } catch (error) {
      throw new Error(`Failed to make OVH call: ${error.message}`);
    }
  }

  async sendSMS(to, from, body) {
    await this.initializeClient();
    try {
      const message = await this.client.requestPromised('POST', '/sms/message', {
        receiver: to,
        sender: from,
        message: body
      });
      return message;
    } catch (error) {
      throw new Error(`Failed to send OVH SMS: ${error.message}`);
    }
  }

  async validateCredentials() {
    await this.initializeClient();
    try {
      await this.client.requestPromised('GET', '/me');
      return true;
    } catch (error) {
      return false;
    }
  }

  async getPhoneNumbers() {
    await this.initializeClient();
    try {
      const numbers = await this.client.requestPromised('GET', '/telephony');
      return numbers;
    } catch (error) {
      throw new Error(`Failed to get OVH phone numbers: ${error.message}`);
    }
  }

  async getCallHistory(lineNumber, fromDate, toDate) {
    await this.initializeClient();
    try {
      const params = {};
      if (fromDate) params.fromDate = fromDate;
      if (toDate) params.toDate = toDate;

      const calls = await this.client.requestPromised('GET', `/telephony/${lineNumber}/calls`, params);
      return calls;
    } catch (error) {
      throw new Error(`Failed to get OVH call history: ${error.message}`);
    }
  }

  async getLineStatus(lineNumber) {
    await this.initializeClient();
    try {
      const status = await this.client.requestPromised('GET', `/telephony/${lineNumber}/status`);
      return status;
    } catch (error) {
      throw new Error(`Failed to get OVH line status: ${error.message}`);
    }
  }
}

module.exports = { OVHService };
