/* const crypto = require('crypto');
require('dotenv').config();

// Variables nécessaires
const applicationSecret = process.env.OVH_APPLICATION_SECRET;
const consumerKey = process.env.OVH_CONSUMER_KEY;
const billingAccount = process.env.OVH_BILLING_ACCOUNT;
const serviceName = process.env.OVH_SERVICE_NAME;
const missing = ['OVH_APPLICATION_KEY', 'OVH_APPLICATION_SECRET', 'OVH_CONSUMER_KEY', 'OVH_BILLING_ACCOUNT', 'OVH_SERVICE_NAME'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Variable(s) OVH absente(s) : ${missing.join(', ')}`);
  process.exit(1);
}
const httpMethod = 'GET'; // ou POST, PUT, etc.
const apiEndpoint = 'https://eu.api.ovh.com';
const requestUrl = '/1.0/me';
const body = ''; // Pour GET, laissez vide. Pour POST, mettez le body JSON en string
const timestamp = Math.floor(Date.now() / 1000); // Timestamp actuel en secondes

// Construire la chaîne à signer
const stringToSign = applicationSecret + '+' + consumerKey + '+' + httpMethod + '+' + apiEndpoint + '+' + requestUrl + '+' + body + '+' + timestamp;

// Générer la signature en SHA1
const signature = '$1$' + crypto.createHash('sha1').update(stringToSign).digest('hex');

console.log('X-Ovh-Timestamp:', timestamp);
console.log('X-Ovh-Signature:', signature);
 */
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

// Configuration OVH
 const applicationKey = process.env.OVH_APPLICATION_KEY;
const applicationSecret = process.env.OVH_APPLICATION_SECRET;
const consumerKey = process.env.OVH_CONSUMER_KEY;
const httpMethod = 'GET';
const apiEndpoint = 'https://eu.api.ovh.com';
const requestUrl = `/1.0/telephony/${billingAccount}/line/${serviceName}/records`;
const body = ''; // GET n'a pas de body
const timestamp = Math.floor(Date.now() / 1000); // Timestamp UNIX

// Construction de la chaîne à signer
const stringToSign = applicationSecret + '+' + consumerKey + '+' + httpMethod + '+' + apiEndpoint + requestUrl + '+' + body + '+' + timestamp;

// Génération de la signature HMAC-SHA1
const signature = '$1$' + crypto.createHash('sha1').update(stringToSign).digest('hex');

// Affichage pour vérification
console.log('X-Ovh-Timestamp:', timestamp);
console.log('X-Ovh-Signature:', signature);

// Requête GET avec Axios
 axios.get(apiEndpoint + requestUrl, {
  headers: {
    'X-Ovh-Application': applicationKey,
    'X-Ovh-Consumer': consumerKey,
    'X-Ovh-Signature': signature,
    'X-Ovh-Timestamp': timestamp
  }
})
.then(response => {
  console.log('Success:', response.data);
})
.catch(error => {
  console.error('Error:', error.response.data);
}); 


 
 /* const applicationKey = process.env.OVH_APPLICATION_KEY;
const applicationSecret = process.env.OVH_APPLICATION_SECRET;
const consumerKey = process.env.OVH_CONSUMER_KEY;
      const billingAccount ='sc899836-ovh-1';
      const serviceName = process.env.OVH_SERVICE_NAME; 
      const apiEndpoint = 'https://eu.api.ovh.com';
      const requestUrl = `/1.0/telephony/${billingAccount}/line/${serviceName}/click2Call`;
      const httpMethod = 'POST';
      const timestamp = Math.floor(Date.now() / 1000);
    
      // Corps de la requête
      const body = JSON.stringify({
        "calledNumber": "+33635426481",
        "callingNumber": "+33183643948",
        "intercom": false
      });
    
      // Construction de la chaîne à signer
      const stringToSign = applicationSecret + '+' + consumerKey + '+' + httpMethod + '+' + apiEndpoint + requestUrl + '+' + body + '+' + timestamp;
    
      // Génération de la signature HMAC-SHA1
      const signature = '$1$' + crypto.createHash('sha1').update(stringToSign).digest('hex');
      console.log("signature",signature);
      console.log("timestamp",timestamp); */