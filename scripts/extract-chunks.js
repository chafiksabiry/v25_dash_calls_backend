const fs = require('fs');
const path = require('path');

/**
 * Extrait les chunks audio d'un fichier de données Telnyx
 * @param {string} telnyxFile - Fichier JSON contenant les messages Telnyx
 * @param {string} outputFile - Fichier de sortie pour les chunks décodés (optionnel)
 * @returns {Promise<Object>} - Statistiques d'extraction
 */
async function extractChunks(telnyxFile, outputFile = null) {
    try {
        // Vérifier que le fichier d'entrée existe
        if (!fs.existsSync(telnyxFile)) {
            throw new Error(`Le fichier ${telnyxFile} n'existe pas`);
        }

        // Si outputFile n'est pas spécifié, créer un nom basé sur telnyxFile
        if (!outputFile) {
            outputFile = telnyxFile.replace(/-telnyx\.json$/, '-extracted-audio.json');
        }

        console.log(`📂 Analyse du fichier ${path.basename(telnyxFile)}...`);

        // Lire et parser le fichier Telnyx
        const telnyxData = JSON.parse(await fs.promises.readFile(telnyxFile, 'utf8'));
        
        // Structure pour les chunks extraits
        const extractedAudio = {
            metadata: {
                sourceFile: path.basename(telnyxFile),
                format: 'PCMU',
                sampleRate: 8000,
                channels: 1,
                extractedAt: new Date().toISOString(),
                totalChunks: 0,
                totalBytes: 0,
                duration: telnyxData.metadata?.duration,
                originalMetadata: telnyxData.metadata
            },
            chunks: []
        };

        // Extraire les chunks audio des messages
        console.log('🔍 Extraction des chunks audio...');
        
        for (const message of telnyxData.messages) {
            if (message.event === 'media' && message.media?.payload) {
                try {
                    const decodedChunk = Buffer.from(message.media.payload, 'base64');
                    
                    extractedAudio.chunks.push({
                        sequence: message.sequence_number,
                        timestamp: message._receivedAt,
                        size: decodedChunk.length,
                        data: decodedChunk.toString('base64')
                    });

                    extractedAudio.metadata.totalChunks++;
                    extractedAudio.metadata.totalBytes += decodedChunk.length;

                } catch (error) {
                    console.warn(`⚠️ Erreur décodage chunk ${message.sequence_number}:`, error.message);
                }
            }
        }

        // Trier les chunks par numéro de séquence
        extractedAudio.chunks.sort((a, b) => parseInt(a.sequence) - parseInt(b.sequence));

        // Ajouter des statistiques sur les séquences
        if (extractedAudio.chunks.length > 0) {
            const sequences = extractedAudio.chunks.map(c => parseInt(c.sequence));
            extractedAudio.metadata.sequenceStats = {
                min: Math.min(...sequences),
                max: Math.max(...sequences),
                gaps: sequences.reduce((gaps, seq, i, arr) => {
                    if (i > 0 && seq !== arr[i-1] + 1) {
                        gaps.push({ from: arr[i-1], to: seq });
                    }
                    return gaps;
                }, [])
            };
        }

        // Sauvegarder les données extraites
        await fs.promises.writeFile(outputFile, JSON.stringify(extractedAudio, null, 2));

        console.log(`✅ Extraction terminée:
        - Chunks extraits: ${extractedAudio.metadata.totalChunks}
        - Taille totale: ${extractedAudio.metadata.totalBytes} bytes
        - Durée: ${extractedAudio.metadata.duration}s
        - Gaps de séquence: ${extractedAudio.metadata.sequenceStats?.gaps.length || 0}
        - Fichier créé: ${path.basename(outputFile)}`);

        return extractedAudio.metadata;
    } catch (error) {
        console.error('❌ Erreur lors de l\'extraction:', error);
        throw error;
    }
}

// Si le script est exécuté directement
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('❌ Usage: node extract-chunks.js <telnyx-file.json> [output-file.json]');
        process.exit(1);
    }

    const inputFile = args[0];
    const outputFile = args[1];

    extractChunks(inputFile, outputFile)
        .then(() => {
            console.log('✨ Extraction terminée avec succès');
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ Erreur:', error);
            process.exit(1);
        });
} else {
    // Exporté comme module
    module.exports = extractChunks;
}