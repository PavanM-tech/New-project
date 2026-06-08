const {
  ANALYSIS_MODEL,
  VOICE_SCENE_PROMPT,
  callGemini,
  extractCandidateText,
  handleMethod,
  parseGeminiJson,
  readJsonBody,
  sendJson,
  synthesizeSpeech,
} = require('./_lib/gemini');

module.exports = async function handler(req, res) {
  if (!handleMethod(req, res)) {
    return;
  }

  try {
    const { audioBase64, audioMimeType, imageBase64 } = readJsonBody(req);

    if (!audioBase64 || !audioMimeType || !imageBase64) {
      sendJson(res, 400, { error: 'Missing audio or image payload.' });
      return;
    }

    const payload = await callGemini(ANALYSIS_MODEL, {
      contents: [
        {
          parts: [
            { text: VOICE_SCENE_PROMPT },
            {
              inlineData: {
                data: imageBase64,
                mimeType: 'image/jpeg',
              },
            },
            {
              inlineData: {
                data: audioBase64,
                mimeType: audioMimeType,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.35,
      },
    });

    const text = extractCandidateText(payload);

    if (!text) {
      throw new Error('Gemini did not return a voice-scene response.');
    }

    const result = parseGeminiJson(text);
    const ttsAudioBase64 = await synthesizeSpeech(result.answerText);

    sendJson(res, 200, {
      result,
      ttsAudioBase64,
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Voice scene request failed.',
    });
  }
};
