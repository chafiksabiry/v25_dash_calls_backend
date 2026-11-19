
const ovh = require('ovh');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();
const { promisify } = require('util');

class OVHService {
  constructor(applicationKey, applicationSecret, consumerKey, endpoint = 'ovh-eu') {
    this.applicationKey = applicationKey || process.env.OVH_APPLICATION_KEY || process.env.OVH_APP_KEY || '';
    this.applicationSecret = applicationSecret || process.env.OVH_APPLICATION_SECRET || process.env.OVH_APP_SECRET || '';
    this.consumerKey = consumerKey || process.env.OVH_CONSUMER_KEY || '';
    this.billingAccount = process.env.OVH_BILLING_ACCOUNT || '';
    this.serviceName = process.env.OVH_SERVICE_NAME || process.env.OVH_DEFAULT_NUMBER || ''; // Le numéro OVH utilisé comme appelant
    this.endpoint = 'ovh-eu';
    this.client = null;
  }

  /** Identifiants OVH : variables d'environnement uniquement (aucune valeur dans le dépôt). Erreur claire si l'une manque. */
  assertConfigured() {
    const missing = [];
    if (!this.applicationKey) missing.push('OVH_APPLICATION_KEY (ou OVH_APP_KEY)');
    if (!this.applicationSecret) missing.push('OVH_APPLICATION_SECRET (ou OVH_APP_SECRET)');
    if (!this.consumerKey) missing.push('OVH_CONSUMER_KEY');
    if (!this.billingAccount) missing.push('OVH_BILLING_ACCOUNT');
    if (!this.serviceName) missing.push('OVH_SERVICE_NAME (ou OVH_DEFAULT_NUMBER)');
    if (missing.length) throw new Error(`Intégration OVH non configurée : variable(s) ${missing.join(', ')} absente(s).`);
  }

    async initializeClient() {
      this.assertConfigured();
      try {
        console.log("we are in the initializeClient");
    
        if (!this.consumerKey) {
          console.log("Consumer key not found, creating one...");
          this.consumerKey = await this.getOrCreateConsumerKey();
        }
    
        console.log("before client initiation");
    
        // Initialisation du client OVH
        this.client = ovh({
          appKey: this.applicationKey,
          appSecret: this.applicationSecret,
          consumerKey: this.consumerKey,
          endpoint: 'ovh-eu',
          debug: true  
        });
    
        console.log("this.client", this.client); // Cela devrait s'afficher si tout va bien
      } catch (error) {
        console.error("Erreur lors de l'initialisation du client OVH :", error);
      }
    }
    

  async getOrCreateConsumerKey() {
    console.log("get consumerKey");
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
      console.log("response from ovh to get the consumerKey",response);

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
        this.assertConfigured();
        console.log("👉 Démarrage de makeCall");
    
        if (!this.client) {
          // Si le client n'est pas initialisé, appelez initializeClient
          await this.initializeClient();
        }
    
        // Corps de la requête
        const body = {
          calledNumber: to,
          callingNumber: from,
          intercom: false
        };
    
        try {
          // Utilisation du client pour faire un appel API via la méthode POST
          const response = await this.client.request({
            method: 'POST',
            url: `/1.0/telephony/${this.billingAccount}/line/${this.serviceName}/click2Call`,
            data: body
          });
    
          console.log('✅ Appel initié avec succès :', response);
          return response;
        } catch (error) {
          console.error('❌ Erreur lors de l\'appel OVH :', error.response?.data || error.message);
          throw new Error('Erreur lors de l\'initialisation de l\'appel.');
        }
      } 
  


makeCall = async (callerNumber, calleeNumber) => {
    try {
        const url = `https://eu.api.ovh.com/1.0/telephony/${OVH_BILLING_ACCOUNT}/ovhPabx/${OVH_SERVICE_NAME}/dialplan`;

        const payload = {
            caller: callerNumber,
            callee: calleeNumber
        };

        const headers = {
            'X-Ovh-Application': OVH_APP_KEY,
            'X-Ovh-Consumer': OVH_CONSUMER_KEY,
            'X-Ovh-Signature': OVH_APP_SECRET,
            'Content-Type': 'application/json'
        };

        const response = await axios.post(url, payload, { headers });
        return response.data;
    } catch (error) {
        console.error('Erreur dans makeCall Service:', error);
        throw new Error('Erreur lors de l\'appel à l\'API OVH');
    }
};
        
  

    

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
