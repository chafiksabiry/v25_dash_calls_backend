function generateAudioTranscriptionPrompt() {
    return `You are given an audio file from a real-time call. Your task is to transcribe it into a structured JSON format with accurate timestamps. Follow these exact rules:

1. Each speech segment must:
  - Be precise.
  - Include start and end timestamps in the exact format mm:ss.SSS relative to the audio chunk.
  - Represent only one continuous piece of speech from a speaker.
  - Start when the speaker begins talking, end when they stop.
  
2. Timestamps must be synchronized with real speech:
  - Start time: when the actual speech begins (not before).
  - End time: when the actual speech stops (not after).
  - Do not merge multiple sentences unless they occur in the same breath without silence.

3. Output format:
[
  {
    "start": "00:00.000",
    "end": "00:02.480",
    "speaker": "Speaker 1",
    "text": "Hello, thank you for calling."
  },
  {
    "start": "00:02.500",
    "end": "00:05.430",
    "speaker": "Speaker 2",
    "text": "Hi, I'm calling about my recent order."
  }
]

4. Do NOT guess content. Do NOT infer text not clearly audible.
5. Do NOT round timestamps. Use millisecond-precision alignment.
6. Do NOT include silence or background noise.
7. Return an empty array [] if no speech is detected.

This transcription will be used for subtitle generation and call analysis. Accuracy of timing is critical.`;
}

module.exports = { generateAudioTranscriptionPrompt };
