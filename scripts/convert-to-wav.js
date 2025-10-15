const fs = require('fs');
const path = require('path');

/**
 * Convertit un fichier PCMU en WAV
 * @param {string} inputFile - Chemin du fichier PCMU d'entrée
 * @param {string} outputFile - Chemin du fichier WAV de sortie (optionnel)
 * @returns {Promise<string>} - Chemin du fichier WAV créé
 */
async function convertPcmuToWav(inputFile, outputFile = null) {
    try {
        // Vérifier que le fichier d'entrée existe
        if (!fs.existsSync(inputFile)) {
            throw new Error(`Le fichier ${inputFile} n'existe pas`);
        }

        // Si outputFile n'est pas spécifié, créer un nom basé sur inputFile
        if (!outputFile) {
            outputFile = inputFile.replace(/-chunks-decoded\.raw$/, '.wav');
        }

        console.log(`🎵 Conversion de ${path.basename(inputFile)} en WAV...`);

        // Lire les données PCMU
        const rawData = await fs.promises.readFile(inputFile);
        const dataSize = rawData.length;
        const fileSize = dataSize + 36; // Taille totale - 8 octets

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
        // Format audio (7 pour µ-law)
        wavHeader.writeUInt16LE(7, 20);
        // Nombre de canaux
        wavHeader.writeUInt16LE(1, 22);
        // Fréquence d'échantillonnage
        wavHeader.writeUInt32LE(8000, 24);
        // Bytes par seconde
        wavHeader.writeUInt32LE(8000, 28);
        // Bytes par échantillon
        wavHeader.writeUInt16LE(1, 32);
        // Bits par échantillon
        wavHeader.writeUInt16LE(8, 34);
        // "data"
        wavHeader.write('data', 36);
        // Taille des données
        wavHeader.writeUInt32LE(dataSize, 40);

        // Écrire le fichier WAV
        const wavFile = await fs.promises.open(outputFile, 'w');
        await wavFile.write(wavHeader);
        await wavFile.write(rawData);
        await wavFile.close();

        console.log(`✅ Conversion terminée: ${path.basename(outputFile)}`);
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
        console.error('❌ Usage: node convert-to-wav.js <input-file> [output-file]');
        process.exit(1);
    }

    const inputFile = args[0];
    const outputFile = args[1];

    convertPcmuToWav(inputFile, outputFile)
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
    module.exports = convertPcmuToWav;
}
