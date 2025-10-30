const fs = require('fs');
const path = require('path');

// Table de conversion µ-law vers PCM linéaire
const MU_LAW_DECODE_TABLE = new Int16Array(256);
(() => {
    for (let i = 0; i < 256; i++) {
        const mu = ~i; // Inversion des bits pour µ-law
        const sign = (mu & 0x80) ? -1 : 1;
        let magnitude = ((mu & 0x70) >> 4) * 2;
        magnitude += ((mu & 0x0F) << 1) + 1;
        let amplitude = magnitude << 2;
        amplitude = ((amplitude + 33) << 3);
        MU_LAW_DECODE_TABLE[i] = sign * amplitude;
    }
})();

/**
 * Convertit un fichier audio JSON en WAV
 * @param {string} inputFile - Fichier JSON contenant les chunks audio décodés
 * @param {string} outputFile - Fichier WAV de sortie (optionnel)
 * @returns {Promise<string>} - Chemin du fichier WAV créé
 */
async function convertToWav(inputFile, outputFile = null) {
    try {
        // Vérifier que le fichier d'entrée existe
        if (!fs.existsSync(inputFile)) {
            throw new Error(`Le fichier ${inputFile} n'existe pas`);
        }

        // Si outputFile n'est pas spécifié, créer un nom basé sur inputFile
        if (!outputFile) {
            outputFile = inputFile.replace(/-audio\.json$/, '.wav');
        }

        console.log(`🎵 Conversion de ${path.basename(inputFile)} en WAV...`);

        // Lire et parser le fichier JSON
        const audioData = JSON.parse(await fs.promises.readFile(inputFile, 'utf8'));

        // Vérifier le format
        if (!audioData.metadata || !Array.isArray(audioData.messages)) {
            throw new Error('Format de fichier audio JSON invalide');
        }

        // Vérifier les métadonnées
        const metadata = audioData.metadata;
        if (metadata.format !== 'PCMU' || metadata.sampleRate !== 8000) {
            throw new Error(`Format audio non supporté: ${metadata.format} ${metadata.sampleRate}Hz`);
        }

        // Trier les chunks par numéro de séquence
        const sortedChunks = audioData.messages.sort((a, b) => 
            parseInt(a.sequence) - parseInt(b.sequence)
        );

        // Calculer la taille totale des données PCM16 (16-bit)
        const totalPcmSize = sortedChunks.reduce((sum, chunk) => sum + chunk.data.length, 0) * 2;
        const fileSize = totalPcmSize + 36; // Taille totale - 8 octets

        // Créer l'en-tête WAV
        const wavHeader = Buffer.alloc(44);

        // "RIFF"
        wavHeader.write('RIFF', 0);
        // Taille totale - 8
        wavHeader.writeUInt32LE(fileSize, 4);
        // "WAVE"
        wavHeader.write('WAVE', 8);
        // "fmt "
        wavHeader.write('fmt ', 12);
        // Taille du bloc fmt (16 pour PCM)
        wavHeader.writeUInt32LE(16, 16);
        // Format audio (1 pour PCM linéaire)
        wavHeader.writeUInt16LE(1, 20);
        // Nombre de canaux
        wavHeader.writeUInt16LE(metadata.channels, 22);
        // Fréquence d'échantillonnage
        wavHeader.writeUInt32LE(metadata.sampleRate, 24);
        // Bytes par seconde (sampleRate * channels * bytesPerSample)
        wavHeader.writeUInt32LE(metadata.sampleRate * metadata.channels * 2, 28);
        // Block align (channels * bytesPerSample)
        wavHeader.writeUInt16LE(metadata.channels * 2, 32);
        // Bits par échantillon
        wavHeader.writeUInt16LE(16, 34);
        // "data"
        wavHeader.write('data', 36);
        // Taille des données
        wavHeader.writeUInt32LE(totalPcmSize, 40);

        // Ouvrir le fichier WAV en écriture
        const wavFile = fs.createWriteStream(outputFile);

        // Écrire l'en-tête WAV
        wavFile.write(wavHeader);

        // Écrire les chunks audio dans l'ordre
        console.log(`📝 Conversion de ${sortedChunks.length} chunks PCMU en PCM16...`);
        
        let processedChunks = 0;
        let lastProgress = 0;

        for (const chunk of sortedChunks) {
            // Convertir PCMU en PCM16
            const pcm16Buffer = Buffer.alloc(chunk.data.length * 2); // 16-bit = 2 bytes par sample
            
            for (let i = 0; i < chunk.data.length; i++) {
                const pcm16Value = MU_LAW_DECODE_TABLE[chunk.data[i]];
                pcm16Buffer.writeInt16LE(pcm16Value, i * 2);
            }

            // Écrire le chunk PCM16
            wavFile.write(pcm16Buffer);
            
            // Mettre à jour la progression
            processedChunks++;
            const progress = Math.floor((processedChunks / sortedChunks.length) * 100);
            
            if (progress >= lastProgress + 10) {
                console.log(`📊 Progression: ${progress}%`);
                lastProgress = progress;
            }
        }

        // Fermer le fichier
        await new Promise((resolve, reject) => {
            wavFile.end();
            wavFile.on('finish', resolve);
            wavFile.on('error', reject);
        });

        console.log(`✅ Conversion terminée:
        - Fichier WAV: ${path.basename(outputFile)}
        - Taille PCM: ${totalPcmSize} bytes
        - Durée: ${metadata.duration}s
        - Chunks: ${sortedChunks.length}
        - Sample rate: ${metadata.sampleRate}Hz
        - Format: PCM 16-bit
        - Canaux: ${metadata.channels}`);

        return outputFile;
    } catch (error) {
        console.error('❌ Erreur lors de la conversion:', error);
        throw error;
    }
}

// Si le script est exécuté directement
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('❌ Usage: node convert-to-wav.js <input-audio.json> [output.wav]');
        process.exit(1);
    }

    const inputFile = args[0];
    const outputFile = args[1];

    convertToWav(inputFile, outputFile)
        .then(wavFile => {
            console.log(`✨ Fichier WAV créé: ${wavFile}`);
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ Erreur:', error);
            process.exit(1);
        });
} else {
    // Exporté comme module
    module.exports = convertToWav;
}