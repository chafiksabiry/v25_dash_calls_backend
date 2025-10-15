const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Créer un serveur WebSocket
const wss = new WebSocket.Server({ port: 5006, path: '/test-audio-stream' });

console.log('🎧 Serveur WebSocket démarré sur ws://localhost:5006/test-audio-stream');

class JsonStreamWriter {
    constructor(filePath) {
        this.filePath = filePath;
        this.stream = fs.createWriteStream(filePath);
        this.isFirstItem = true;
        this.initializeStream();
    }

    initializeStream() {
        // Écrire le début du fichier JSON
        this.stream.write('{\n');
        this.stream.write('  "messages": [\n');
    }

    writeMessage(message) {
        // Ajouter la virgule si ce n'est pas le premier élément
        if (!this.isFirstItem) {
            this.stream.write(',\n');
        }
        this.isFirstItem = false;

        // Écrire le message avec indentation
        this.stream.write('    ' + JSON.stringify(message));
    }

    writeMetadata(metadata) {
        // Fermer le tableau des messages
        this.stream.write('\n  ],\n');
        // Écrire les métadonnées
        this.stream.write('  "metadata": ' + JSON.stringify(metadata, null, 2));
        // Fermer l'objet JSON
        this.stream.write('\n}');
        // Fermer le stream
        this.stream.end();
    }
}

wss.on('connection', (ws) => {
    console.log('🔌 Nouvelle connexion WebSocket établie');
    
    // Créer les fichiers pour l'enregistrement
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Créer les writers JSON
    const telnyxWriter = new JsonStreamWriter(
        path.join(__dirname, 'recordings', `call-${timestamp}-telnyx.json`)
    );
    const audioWriter = new JsonStreamWriter(
        path.join(__dirname, 'recordings', `call-${timestamp}-audio.json`)
    );

    // Initialiser les métadonnées
    const metadata = {
        startTime: new Date().toISOString(),
        format: 'PCMU',
        sampleRate: 8000,
        channels: 1,
        totalMessages: 0,
        mediaChunks: 0,
        events: {},
        totalBytes: {
            raw: 0,
            decoded: 0
        }
    };

    const audioMetadata = {
        format: 'PCMU',
        sampleRate: 8000,
        channels: 1,
        totalChunks: 0,
        totalBytes: 0,
        timestamps: [],
        startTime: new Date().toISOString()
    };
    
    console.log(`📝 Enregistrement démarré pour la session ${timestamp}`);

    ws.on('message', (data) => {
        try {
            // 1. Traiter le message Telnyx
            const messageStr = data.toString();
            metadata.totalMessages++;
            
            try {
                // Essayer de parser comme JSON
                const message = JSON.parse(messageStr);
                
                // Ajouter le timestamp de réception
                message._receivedAt = new Date().toISOString();
                
                // Écrire dans le fichier Telnyx
                telnyxWriter.writeMessage(message);
                
                // Mettre à jour les statistiques
                if (message.event !== 'media') {
                    metadata.events[message.event] = (metadata.events[message.event] || 0) + 1;
                }

                // 2. Si c'est un chunk audio, le traiter
                if (message.event === 'media' && message.media?.payload) {
                    const decodedChunk = Buffer.from(message.media.payload, 'base64');
                    
                    // Écrire le chunk audio
                    const audioChunk = {
                        sequence: message.sequence_number,
                        timestamp: Date.now(),
                        size: decodedChunk.length,
                        data: message.media.payload // Garder en base64
                    };
                    audioWriter.writeMessage(audioChunk);

                    // Mettre à jour les statistiques
                    metadata.mediaChunks++;
                    metadata.totalBytes.decoded += decodedChunk.length;
                    audioMetadata.totalChunks++;
                    audioMetadata.totalBytes += decodedChunk.length;
                    audioMetadata.timestamps.push(Date.now());
                }

            } catch (e) {
                // Si ce n'est pas du JSON valide, enregistrer comme message brut
                telnyxWriter.writeMessage({
                    type: 'raw',
                    data: messageStr,
                    timestamp: new Date().toISOString()
                });
            }

            // Log périodique
            if (metadata.mediaChunks % 100 === 0 && metadata.mediaChunks > 0) {
                console.log(`📼 Progression:
                - Messages totaux: ${metadata.totalMessages}
                - Chunks audio: ${metadata.mediaChunks}
                - Taille audio décodée: ${metadata.totalBytes.decoded} bytes`);
            }

        } catch (error) {
            console.error('❌ Erreur lors du traitement des données:', error);
        }
    });

    ws.on('close', () => {
        console.log('🔌 Connexion WebSocket fermée');
        
        // Finaliser les métadonnées
        metadata.endTime = new Date().toISOString();
        metadata.duration = (new Date(metadata.endTime) - new Date(metadata.startTime)) / 1000;

        // Finaliser les métadonnées audio
        audioMetadata.endTime = new Date().toISOString();
        audioMetadata.duration = (audioMetadata.timestamps[audioMetadata.timestamps.length - 1] - 
                                audioMetadata.timestamps[0]) / 1000;
        
        // Écrire les métadonnées finales
        telnyxWriter.writeMetadata(metadata);
        audioWriter.writeMetadata(audioMetadata);
        
        console.log(`✅ Enregistrement terminé:
        - Durée: ${metadata.duration}s
        - Messages Telnyx: ${metadata.totalMessages}
        - Chunks audio: ${audioMetadata.totalChunks}
        - Taille audio: ${audioMetadata.totalBytes} bytes`);
    });

    ws.on('error', (error) => {
        console.error('❌ Erreur WebSocket:', error);
        // Fermer proprement les fichiers en cas d'erreur
        telnyxWriter.writeMetadata(metadata);
        audioWriter.writeMetadata(audioMetadata);
    });
});

// Gérer l'arrêt propre du serveur
process.on('SIGINT', () => {
    wss.close(() => {
        console.log('👋 Serveur WebSocket arrêté');
        process.exit(0);
    });
});