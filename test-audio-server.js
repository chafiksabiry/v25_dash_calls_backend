const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Créer un serveur WebSocket
const wss = new WebSocket.Server({ port: 5006, path: '/test-audio-stream' });

console.log('🎧 Serveur WebSocket démarré sur ws://localhost:5006/test-audio-stream');

wss.on('connection', (ws) => {
    console.log('🔌 Nouvelle connexion WebSocket établie');
    
    // Créer un fichier pour enregistrer l'audio
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const audioFile = path.join(__dirname, 'recordings', `call-${timestamp}.raw`);
    const writeStream = fs.createWriteStream(audioFile);
    
    console.log(`📝 Enregistrement dans le fichier: ${audioFile}`);

    ws.on('message', (data) => {
        try {
            // Écrire les données audio dans le fichier
            writeStream.write(data);
            console.log(`📼 Chunk audio reçu: ${data.length} bytes`);
        } catch (error) {
            console.error('❌ Erreur lors de l\'écriture des données audio:', error);
        }
    });

    ws.on('close', () => {
        console.log('🔌 Connexion WebSocket fermée');
        writeStream.end();
        console.log(`✅ Enregistrement terminé: ${audioFile}`);
    });

    ws.on('error', (error) => {
        console.error('❌ Erreur WebSocket:', error);
        writeStream.end();
    });
});

// Gérer l'arrêt propre du serveur
process.on('SIGINT', () => {
    wss.close(() => {
        console.log('👋 Serveur WebSocket arrêté');
        process.exit(0);
    });
});
