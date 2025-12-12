const WebSocket = require('ws');
const { activeCalls } = require('./audioServer');

let io; // Référence Socket.IO
let telnyxStreams = new Map(); // Map des streams Telnyx par call_control_id

// Gérer le Media Stream de Telnyx (audio bidirectionnel)
function handleTelnyxMediaStream(ws, req) {
  // Extraire le call_control_id de l'URL
  const url = new URL(req.url, 'wss://localhost');
  const currentCallId = url.searchParams.get('callControlId');
  
  console.log(`🎵 Telnyx Media Stream connecté pour call: ${currentCallId}`);
  
  if (!currentCallId) {
    console.error('❌ Pas de callControlId dans l\'URL du stream');
    ws.close();
    return;
  }
  
  // Stocker le stream dès la connexion
  telnyxStreams.set(currentCallId, ws);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch(data.event) {
        case 'start':
          console.log(`🎤 Stream démarré pour call: ${currentCallId}`);
          break;
          
        case 'media':
          // Audio reçu de Telnyx (voix du receiver)
          if (currentCallId && data.media && data.media.payload) {
            sendAudioToFrontend(currentCallId, data.media.payload);
          }
          break;
          
        case 'stop':
          console.log(`🔇 Stream terminé pour call: ${currentCallId}`);
          telnyxStreams.delete(currentCallId); // Retirer le stream
          break;
      }
    } catch (error) {
      console.error('❌ Erreur Media Stream:', error);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Telnyx Media Stream déconnecté');
    if (currentCallId) {
      telnyxStreams.delete(currentCallId);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ Erreur WebSocket Media Stream:', error);
  });

  // Fonction pour envoyer audio du frontend vers Telnyx
  ws.sendAudioToTelnyx = (audioData) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          payload: audioData
        }
      }));
    }
  };

  return ws;
}

// Envoyer l'audio au client frontend via Socket.IO
function sendAudioToFrontend(callControlId, audioPayload) {
  if (!io) return;
  
  const call = activeCalls.get(callControlId);
  if (call) {
    const socket = io.sockets.sockets.get(call.socketId);
    if (socket) {
      socket.emit('audio-received', {
        callControlId,
        audioChunk: audioPayload,
        timestamp: Date.now()
      });
    }
  }
}

// Envoyer l'audio du frontend vers Telnyx
function sendAudioToTelnyx(callControlId, audioPayload) {
  const telnyxWs = telnyxStreams.get(callControlId);
  
  if (telnyxWs && telnyxWs.readyState === WebSocket.OPEN) {
    telnyxWs.send(JSON.stringify({
      event: 'media',
      media: {
        payload: audioPayload
      }
    }));
  }
}

function setIO(socketIO) {
  io = socketIO;
}

module.exports = {
  handleTelnyxMediaStream,
  sendAudioToTelnyx,
  setIO
};

