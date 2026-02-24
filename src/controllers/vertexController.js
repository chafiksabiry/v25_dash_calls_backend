const vertexAIService = require('../services/vertexai.service');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// Helper to handle service errors in controller
const handleControllerError = (res, error, defaultMessage = 'An error occurred') => {
    console.error(`❌ [VertexController] ${defaultMessage}:`, error);
    const status = error.status || 500;
    const message = error.message || defaultMessage;
    res.status(status).json({
        success: false,
        error: message,
        details: error.originalError || error.message || null
    });
};

exports.summarizeAudio = async (req, res) => {
    try {
        const { recordingId } = req.body;
        if (!recordingId) return res.status(400).json({ error: 'recordingId is required' });

        const result = await vertexAIService.getCallSummary(recordingId);
        res.json(result);
    } catch (error) {
        handleControllerError(res, error, 'Error summarizing audio');
    }
};

exports.getCallTranscription = async (req, res) => {
    try {
        const { recordingId } = req.body;
        if (!recordingId) return res.status(400).json({ error: 'recordingId is required' });

        const transcription = await vertexAIService.getCallTranscription(recordingId);
        res.json({ success: true, transcription });
    } catch (error) {
        handleControllerError(res, error, 'Error getting transcription');
    }
};

exports.getCallScoring = async (req, res) => {
    try {
        const { recordingId } = req.body;
        const result = await vertexAIService.getCallScoring(recordingId);
        res.json({ success: true, ...result });
    } catch (error) {
        handleControllerError(res, error, 'Error getting call scoring');
    }
};

exports.getCallPostActions = async (req, res) => {
    try {
        const { recordingId } = req.body;
        const result = await vertexAIService.getCallPostActions(recordingId);
        res.json({ success: true, ...result });
    } catch (error) {
        handleControllerError(res, error, 'Error getting post actions');
    }
};

exports.evaluateRepLanguage = async (req, res) => {
    try {
        const { fileUri, textToCompare } = req.body;
        if (!fileUri || !textToCompare) {
            return res.status(400).json({ error: 'fileUri and textToCompare are required' });
        }
        const response = await vertexAIService.analyzeCallPhase(textToCompare);
        res.json(response);
    } catch (error) {
        handleControllerError(res, error, 'Error during language evaluation');
    }
};

exports.transcribeShortAudio = async (req, res) => {
    try {
        const { audio, language } = req.body;
        if (!audio) return res.status(400).json({ error: 'Audio data (base64) is required' });

        const transcriptionResult = await vertexAIService.transcribeAudio(audio, language);
        res.json(transcriptionResult);
    } catch (error) {
        handleControllerError(res, error, 'Error transcribing short audio');
    }
};

exports.transcribeLongAudio = async (req, res) => {
    try {
        const { fileUri, languageCode } = req.body;
        if (!fileUri) return res.status(400).json({ error: 'fileUri (gs://...) is required' });

        const transcription = await vertexAIService.transcribeLongAudio(languageCode || 'en-US', fileUri);
        res.json({ transcription });
    } catch (error) {
        handleControllerError(res, error, 'Error transcribing long audio');
    }
};

exports.audioUpload = async (req, res) => {
    try {
        const { filePath, destinationName } = req.body;
        if (!filePath || !destinationName) {
            return res.status(400).json({ error: 'filePath and destinationName are required' });
        }

        const uploadResult = await vertexAIService.audioUpload(filePath, destinationName);
        res.json(uploadResult);
    } catch (error) {
        handleControllerError(res, error, 'Error uploading audio');
    }
};

exports.uploadAudioHandler = [
    upload.single('file'),
    async (req, res) => {
        try {
            const { destinationName } = req.body;
            if (!req.file || !destinationName) {
                return res.status(400).json({ error: 'File and destinationName are required' });
            }

            const fileBuffer = req.file.buffer;
            const result = await vertexAIService.audioUploadBuffer(fileBuffer, destinationName);
            res.json(result);
        } catch (error) {
            handleControllerError(res, error, 'Error during buffer upload');
        }
    },
];
