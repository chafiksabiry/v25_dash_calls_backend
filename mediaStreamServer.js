const WebSocket = require('ws');
const { activeCalls } = require('./audioServer');

let wss;
let io; // Référence au serveur Socket.IO

// Initialiser le serveur WebSocket pour le Media Stream de Telnyx
function initializeMediaStreamServer(server, socketIO) {
  io = socketIO;
  
  wss = new WebSocket.Server({ 
    server,
    path: '/audio-stream'
  });

  console.log('🎵 Media Stream WebSocket initialisé sur /audio-stream');

  wss.on('connection', (ws, req) => {
    console.log('📞 Telnyx Media Stream connecté');
    
    let callControlId = null;

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        // Event types de Telnyx Media Stream
        switch(data.event) {
          case 'start':
            callControlId = data.call_control_id;
            console.log(`🎤 Stream audio démarré pour call: ${callControlId}`);
            break;
            
          case 'media':
            // Audio reçu de Telnyx (base64 encodé, PCMU format)
            if (callControlId && data.media && data.media.payload) {
              // Envoyer l'audio au client frontend via Socket.IO
              sendAudioToFrontend(callControlId, data.media.payload);
            }
            break;
            
          case 'stop':
            console.log(`🔇 Stream audio terminé pour call: ${callControlId}`);
            callControlId = null;
            break;
            
          default:
            console.log('📨 Event Telnyx:', data.event);
        }
      } catch (error) {
        console.error('❌ Erreur traitement message Telnyx:', error);
      }
    });

    ws.on('close', () => {
      console.log('🔌 Telnyx Media Stream déconnecté');
    });

    ws.on('error', (error) => {
      console.error('❌ Erreur Media Stream:', error);
    });
  });
}

// Envoyer l'audio au client frontend
function sendAudioToFrontend(callControlId, audioPayload) {
  const call = activeCalls.get(callControlId);
  
  if (call && io) {
    const socket = io.sockets.sockets.get(call.socketId);
    
    if (socket) {
      // Envoyer l'audio au frontend via Socket.IO
      socket.emit('audio-received', {
        callControlId,
        audioChunk: audioPayload,
        timestamp: Date.now()
      });
    }
  }
}

module.exports = {
  initializeMediaStreamServer
};

