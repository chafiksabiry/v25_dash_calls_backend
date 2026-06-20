function generateAudioTranscriptionPrompt() {
  return `You are given an audio file from a real-time call. Your task is to transcribe it into a structured JSON format with accurate timestamps. Follow these exact rules:

1. LANGUAGE: The call is primarily in FRENCH (or sometimes Arabic/English).
   - Transcribe strictly what is said.
   - Do NOT output Hindi, Chinese, or any other unrelated scripts.
   - If the audio is unclear, do NOT hallucinate random languages.

2. Each speech segment must:
   - Be 1–5 seconds long (never more than 6 seconds).
   - Include start and end timestamps in the exact format mm:ss.SSS.
   - Represent only one continuous piece of speech from a speaker.
   - Start when the speaker begins talking, end when they stop.
   
3. Timestamps must be synchronized with real speech:
   - Start time: when the actual speech begins (not before).
   - End time: when the actual speech stops (not after).
   - Do not merge multiple sentences unless they occur in the same breath without silence.

4. Output format:
[
  {
    "start": "00:00.000",
    "end": "00:02.480",
    "speaker": "Speaker 1",
    "text": "Bonjour, merci d'avoir appelé."
  },
  {
    "start": "00:02.500",
    "end": "00:05.430",
    "speaker": "Speaker 2",
    "text": "Bonjour, je vous appelle pour ma commande."
  }
]

5. Do NOT guess content. Do NOT infer text not clearly audible.
6. Do NOT round timestamps. Use millisecond-precision alignment.
7. Do NOT include silence or background noise.
8. Return an empty array [] if no speech is detected.
9. SPEAKER COUNT: If you hear only ONE human voice (even if the person alternates phrases as if playing two roles), label every turn with the same speaker (e.g. "Speaker 1"). Do NOT invent a second speaker.

This transcription will be used for subtitle generation and call analysis. Accuracy of timing is critical.`;
}

module.exports = { generateAudioTranscriptionPrompt };
