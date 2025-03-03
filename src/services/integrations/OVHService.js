
const ovh = require('ovh');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();
const { promisify } = require('util');

class OVHService {
  constructor(applicationKey, applicationSecret, consumerKey, endpoint = 'ovh-eu') {
    this.applicationKey = '951ed23a2d85dc98';
    this.applicationSecret = 'f084e28c889418c3093aed237a8b7198';
    this.consumerKey = 'f0571ddbe535f8b38c02274b577165cf';
    this.billingAccount = 'sc899836-ovh-1';
    this.serviceName = '003256944960'; // Le numéro OVH utilisé comme appelant
    this.endpoint = 'ovh-eu';
    this.client = null;
  }

/*   async initializeClient() {
    console.log("we are in the initializeClient")
    if (!this.consumerKey) {
      this.consumerKey = await this.getOrCreateConsumerKey();
    }
console.log("before client initiation");
    this.client = ovh({
      appKey: '951ed23a2d85dc98',
      appSecret: 'f084e28c889418c3093aed237a8b7198',
      consumerKey: 'f0571ddbe535f8b38c02274b577165cf',
      endpoint: 'eu.api.ovh.com'
    });
    console.log("this.client",this.client);
  } */
    async initializeClient() {
      try {
        console.log("we are in the initializeClient");
    
        if (!this.consumerKey) {
          console.log("Consumer key not found, creating one...");
          this.consumerKey = await this.getOrCreateConsumerKey();
        }
    
        console.log("before client initiation");
    
        // Initialisation du client OVH
        this.client = ovh({
          appKey: '951ed23a2d85dc98',
          appSecret: 'f084e28c889418c3093aed237a8b7198',
          consumerKey: 'f0571ddbe535f8b38c02274b577165cf',
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

/*   async makeCall(to, from) {
    console.log("we are in makeCall");
    await this.initializeClient();
    try {
      const call = await this.client.requestPromised('POST', '/telephony/line/calls', {
        to,
        from,
        type: 'voice'
      });
      console.log("call in requestPromised",call);
      return call;
    } catch (error) {
      throw new Error(`Failed to make OVH call: ${error.message}`);
    }
  } */
/*     async makeCall(to, from) {
      console.log("we are in makeCall");
      await this.initializeClient();
      try {
        const call = await this.client.requestPromised('POST', '/telephony/line/calls', {
          to,
          from,
          type: 'voice'
        });
        console.log("call in requestPromised", call);
        return call;
      } catch (error) {
        console.error("Error details:", error); // Log the full error object
        throw new Error(`Failed to make OVH call: ${error.message || error}`); // Include more details if needed
      }
    } */
   

/* async  makeCall(to, from, billingAccount, serviceName) {
  try {
    const response = await axios.post(
      `https://eu.api.ovh.com/1.0/telephony/${billingAccount}/line/${serviceName}/click2Call`,
      {
        calledNumber: to,
        callingNumber: from,
        intercom: false
      },
      {
        headers: {
          'Content-Type': 'application/json',
        }
      }
    );

    console.log('Call initiated:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error making call:', error.response ? error.response.data : error.message);
    throw new Error(`Failed to initiate the call: ${error.message}`);
  }
} */


  
 /*  async  makeCall(to, from, billingAccount, serviceName) {
    const applicationKey = process.env.OVH_APPLICATION_KEY;
    const consumerKey = process.env.OVH_CONSUMER_KEY;
    const applicationSecret = process.env.OVH_APPLICATION_SECRET;
    const bearerToken = 'eyJhbGciOiJFZERTQSIsImtpZCI6IkVGNThFMkUxMTFBODNCREFEMDE4OUUzMzZERTk3MDhFNjRDMDA4MDEiLCJraW5kIjoib2F1dGgyIiwidHlwIjoiSldUIn0.eyJBY2Nlc3NUb2tlbiI6ImQ3MzQzZGYzNjA4MTJlOWUwZjZiZjhmMjUwNDAwMWMyN2E2NTY3ZDgxZWU1Mjk0MDcxMGZiZWE0NzE5ZDJiNTQiLCJpYXQiOjE3MzkzNjM4MDN9.fqXJJu4d1mY5R2-XLXSqaj8Z2MPbC41xgCNFyAewXNVfCKshAFrubETaMq8MUfhWTTFQj541PRj4Z_1OFV3dBg';
  
    const body = {
      calledNumber: to,
      callingNumber: from,
      intercom: false
    };
  
    const timestamp = Math.floor(Date.now() / 1000); // Timestamp UNIX
    const date = new Date().toUTCString();
  
    // Créer la signature OVH
    const signature = `$${applicationSecret}$${timestamp}$POST$${'/1.0/telephony/' + billingAccount + '/line/' + serviceName + '/click2Call'}$${JSON.stringify(body)}`;
    const hashedSignature = crypto.createHmac('sha1', applicationSecret).update(signature).digest('hex');
  
    try {
      const response = await axios.post(
        `https://eu.api.ovh.com/1.0/telephony/${billingAccount}/line/${serviceName}/click2Call`,
        body,
        {
          headers: {
            'X-Ovh-Application': applicationKey,
            'X-Ovh-Consumer': consumerKey,
            'X-Ovh-Signature': `+${hashedSignature}`, // Ajout de la signature OVH
            'X-Ovh-Timestamp': timestamp, // Ajout du timestamp
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${bearerToken}` // Ajout du Bearer token dans l'en-tête
          }
        }
      );
  
      console.log('Call initiated:', response.data);
      return response.data;
    } catch (error) {
      console.error('Error making call:', error.response ? error.response.data : error.message);
      throw new Error(`Failed to initiate the call: ${error.message}`);
    }
  } */

    
/*    async makeCall(to, from) {
      console.log("👉 Démarrage de makeCall");
    
      // Configuration OVH
      const applicationKey = '951ed23a2d85dc98';
const applicationSecret = 'f084e28c889418c3093aed237a8b7198';
const consumerKey = 'f0571ddbe535f8b38c02274b577165cf';
      const billingAccount ='sc899836-ovh-1';
      const serviceName = '0033183643948'; 
      const apiEndpoint = 'https://eu.api.ovh.com';
      const requestUrl = `/1.0/telephony/${billingAccount}/line/${serviceName}/click2Call`;
      const httpMethod = 'POST';
      const timestamp = Math.floor(Date.now() / 1000);
    
      // Corps de la requête
      const body = JSON.stringify({
        "calledNumber": to,
        "callingNumber": from,
        "intercom": false
      });
    
      // Construction de la chaîne à signer
      const stringToSign = applicationSecret + '+' + consumerKey + '+' + httpMethod + '+' + apiEndpoint + requestUrl + '+' + body + '+' + timestamp;
    
      // Génération de la signature HMAC-SHA1
      const signature = '$1$' + crypto.createHash('sha1').update(stringToSign).digest('hex');
      console.log("signature",signature);
      console.log("timestamp",timestamp);
      try {
        // Requête POST avec Axios
        const response = await axios.post(apiEndpoint + requestUrl, body, {
          headers: {
            'X-Ovh-Application': applicationKey,
            'X-Ovh-Consumer': consumerKey,
            'X-Ovh-Signature': signature,
            'X-Ovh-Timestamp': timestamp,
            'Content-Type': 'application/json'
          }
        });
  
        console.log('✅ Appel initié avec succès :', response);
        return response.data;
      } catch (error) {
        console.error('❌ Erreur lors de l\'appel OVH :', error.response?.data || error.message);
        throw new Error('Erreur lors de l\'initialisation de l\'appel.');
      }
    }  */
      async makeCall(to, from) {
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
    /*     async makeCall(to, from) {
          console.log("👉 Démarrage de makeCall");
        
          // Vérification de l'initialisation du client
          if (!this.client) {
            console.log("Client non initialisé, initialisation en cours...");
            await this.initializeClient();
          }
        
          try {
            // Configuration OVH
            const billingAccount = 'sc899836-ovh-1';
            const serviceName = '003256944960'; // Numéro OVH utilisé comme appelant
            const requestUrl = `/telephony/${billingAccount}/line/${serviceName}/click2Call`;
            const body = {
              "calledNumber": to,
              "callingNumber": from,
              "intercom": false
            };
        
            // Requête OVH
            const response = await this.client.request('POST', requestUrl, body);
            console.log('✅ Appel initié avec succès :', response);
            return response;
          } catch (error) {
            console.error('❌ Erreur lors de l\'appel OVH :', error);
            throw new Error('Erreur lors de l\'appel OVH.');
          }
        }
         */
/* 
        async makeCall(to, from) {
          console.log("👉 Démarrage de makeCall");
        console.log("to",to);
        console.log("from",from);
          // Vérification de l'initialisation du client
          if (!this.client) {
            console.log("Client non initialisé, initialisation en cours...");
            await this.initializeClient();
          }
        
          const billingAccount = 'sc899836-ovh-1';
          const serviceName = '0033183643948'; // Numéro OVH utilisé comme appelant
          const requestUrl = `/telephony/${billingAccount}/line/${serviceName}/click2Call`;
          const body = {
            "calledNumber": to,
            "callingNumber": from,
            "intercom": false
          };
        
          // Utilisation de callback pour gérer la requête
          this.client.request('POST', requestUrl, body, function (error, response) {
            if (error) {
              console.error('❌ Erreur lors de l\'appel OVH :', error);
              throw new Error('Erreur lors de l\'appel OVH.');
            }
            console.log('✅ Appel initié avec succès :', response);
            return response;
          });
        } */
   /*        async makeCall(to, from) {
            console.log("👉 Démarrage de makeCall");
            console.log("to", to);
            console.log("from", from);
            
            // Vérification de l'initialisation du client
            if (!this.client) {
              console.log("Client non initialisé, initialisation en cours...");
              await this.initializeClient();
            }
          
            const billingAccount = 'sc899836-ovh-1';
            const serviceName = '0033183643948';
            const requestUrl = `/telephony/${billingAccount}/line/${serviceName}/click2Call`;
            const body = {
              "calledNumber": to,
              "callingNumber": from,
              "intercom": false
            };
          
            // Convert callback to Promise
            return new Promise((resolve, reject) => {
              this.client.request('POST', requestUrl, body, (error, response) => {
                if (error) {
                  console.error('❌ Erreur lors de l\'appel OVH :', error);
                  reject(error);
                } else {
                  console.log('✅ Appel initié avec succès :', response);
                  resolve(response);
                }
              });
            });
          } 
           */
  


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
