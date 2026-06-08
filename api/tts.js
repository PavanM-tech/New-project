const {
  TTS_MODEL,
  TTS_VOICE,
  callGemini,
  handleMethod,
  readJsonBody,
  sendJson,
} = require('./_lib/gemini');

module.exports = async function handler(req, res) {
  if (!handleMethod(req, res)) {
    return;
  }

  try {
    const { text } = readJsonBody(req);

    if (!text || typeof text !== 'string') {
      sendJson(res, 400, { error: 'Missing text payload.' });
      return;
    }

    const payload = await callGemini(TTS_MODEL, {
      contents: [
        {
          parts: [
            {
              text: `[friendly, helpful] ${text}`,
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode: 'en-IN',
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: TTS_VOICE,
            },
          },
        },
      },
    });

    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'TTS request failed.',
    });
  }
};
