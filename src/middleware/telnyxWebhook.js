const telnyx = require('telnyx');
const { config } = require('../config/env');

/**
 * Middleware to verify Telnyx webhook signatures
 */
function verifyTelnyxWebhook(req, res, next) {
  try {
    const signatureHeader = req.headers['telnyx-signature-ed25519'];
    const timestampHeader = req.headers['telnyx-timestamp'];

    if (!signatureHeader || !timestampHeader) {
      console.error('Missing Telnyx signature headers');
      return res.status(400).json({ error: 'Missing signature headers' });
    }

    // Get raw body from the request (should be a Buffer)
    const rawBody = req.body;

    // Verify the webhook using Telnyx's SDK
    const event = telnyx.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      timestampHeader,
      config.TELNYX_PUBLIC_KEY
    );

    // If we get here, verification was successful
    console.log('✅ Webhook verified successfully:', event.data.event_type);
    
    // Attach the verified event to the request for later use
    req.telnyxEvent = event;

    next();
  } catch (error) {
    console.error('❌ Invalid Telnyx signature or error:', error.message);
    res.status(400).json({ error: `Webhook verification failed: ${error.message}` });
  }
}

module.exports = { verifyTelnyxWebhook };