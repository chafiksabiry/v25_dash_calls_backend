/* const crypto = require('crypto');
require('dotenv').config();

// Variables nécessaires
const applicationSecret = process.env.OVH_APPLICATION_SECRET;
const consumerKey = '10b0ff940492f37a012605512e54cc85';
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
 const applicationKey = '951ed23a2d85dc98';
const applicationSecret = 'f084e28c889418c3093aed237a8b7198';
const consumerKey = 'f0571ddbe535f8b38c02274b577165cf';
const httpMethod = 'GET';
const apiEndpoint = 'https://eu.api.ovh.com';
const requestUrl = '/1.0/telephony/sc899836-ovh-1/line/0033183643948/records';
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


 
 /* const applicationKey = '951ed23a2d85dc98';
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