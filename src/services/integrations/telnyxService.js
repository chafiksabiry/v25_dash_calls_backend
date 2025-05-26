
const axios = require('axios');
const jwt = require('jsonwebtoken');

exports.generateLoginToken = async () => {
  console.log('generateLoginToken', process.env.TELNYX_CONNECTION_ID, process.env.TELNYX_USERNAME, process.env.TELNYX_PASSWORD, process.env.TELNYX_API_KEY);
   /*  try {
      const response = await axios.post(
        'https://api.telnyx.com/v2/telephony_credentials/login_token',
        {
          connection_id: process.env.TELNYX_CONNECTION_ID,
          credential_username: process.env.TELNYX_USERNAME,
          credential_password: process.env.TELNYX_PASSWORD,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          },
        }
      );
  
      return response.data.data.token;
    } catch (error) {
      console.error('Error in Telnyx service:', error.response?.data || error.message);
      throw new Error('Failed to generate Telnyx login token');
    } */

      const token = jwt.sign(
        {
          // Votre username SIP
          sub: 'gencredzsXlMT4HXy5wdf9f3OX92IBTLIv1PnnzXvR5wtC84O',
          exp: Math.floor(Date.now() / 1000) + (60 * 60), // expire dans 1 heure
        },
        'YOUR_API_KEY', // Ou token partagé selon config Telnyx
        {
          algorithm: 'HS256',
        }
      );
      
      console.log('token',token);
      return token;
      
  };

 