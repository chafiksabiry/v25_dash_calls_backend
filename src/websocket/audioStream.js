const WebSocket = require('ws');

// Référence à la connexion Telnyx active
let telnyxConnection = null;

// Référence au broadcaster frontend
let frontendBroadcaster = null;

function setupAudioStream(wsServer, frontendAudioStream) {
  // Stocker la référence au broadcaster frontend
  frontendBroadcaster = frontendAudioStream;

  wsServer.on('connection', (ws, req) => {
    try {
      // Vérifier si c'est une connexion Telnyx
      const isTelnyx = req.headers['user-agent']?.toLowerCase().includes('telnyx') || 
                      req.headers['x-telnyx-signature'];

      if (!isTelnyx) {
        console.war('not telnyx, client : ')
        console.warn('❌ Connexion non-Telnyx rejetée');
        ws.close();
        return;
      }

      console.log('🎧 Telnyx audio stream connected');
      telnyxConnection = ws;

      // Confirmer la connexion à Telnyx
      ws.send(JSON.stringify({ event: "connected", version: "1.0.0" }));

      ws.on('message', (data) => {
        try {
          const messageStr = data.toString();
          let message;

          try {
            message = JSON.parse(messageStr);

            switch (message.event) {
              case 'start':
                console.log('🎵 Stream starting:', message.stream_id, message.start.media_format);
                // Transmettre tel quel au frontend
                frontendBroadcaster.broadcastToClients(message);
                break;

              case 'media':
                if (!message.media?.payload) return;
                // Transmettre tel quel au frontend
                frontendBroadcaster.broadcastToClients(message);
                break;

              case 'stop':
                console.log('🛑 Stream stopped:', message.stream_id);
                frontendBroadcaster.broadcastToClients(message);
                break;

              case 'error':
                console.error('❌ Stream error:', message);
                frontendBroadcaster.broadcastToClients(message);
                break;
            }
          } catch (parseError) {
            console.warn('⚠️ Message non-JSON ignoré:', parseError);
          }
        } catch (err) {
          console.error('❌ Error processing Telnyx message:', err);
        }
      });

      ws.on('close', () => {
        console.log('🔌 Telnyx connection closed');
        telnyxConnection = null;
      });

      ws.on('error', (error) => {
        console.error('❌ Telnyx WebSocket error:', error);
        telnyxConnection = null;
      });

    } catch (error) {
      console.error('❌ Error in Telnyx audio stream connection:', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: 'error',
          payload: { code: 100002, title: 'Connection error', detail: error.message }
        }));
        ws.close();
      }
    }
  });
}

module.exports = setupAudioStream;