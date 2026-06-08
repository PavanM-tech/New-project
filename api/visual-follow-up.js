const {
  ANALYSIS_MODEL,
  NOTEBOOK_FOLLOW_UP_PROMPT,
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
    const { imageBase64, mode } = readJsonBody(req);

    if (!imageBase64 || mode !== 'show_notebook_math') {
      sendJson(res, 400, { error: 'Invalid follow-up payload.' });
      return;
    }

    const payload = await callGemini(ANALYSIS_MODEL, {
      contents: [
        {
          parts: [
            { text: NOTEBOOK_FOLLOW_UP_PROMPT },
            {
              inlineData: {
                data: imageBase64,
                mimeType: 'image/jpeg',
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });

    const text = extractCandidateText(payload);

    if (!text) {
      throw new Error('Gemini did not return a visual follow-up response.');
    }

    const result = parseGeminiJson(text);
    const ttsAudioBase64 = result.resolved ? await synthesizeSpeech(result.answerText) : undefined;

    sendJson(res, 200, {
      result,
      ttsAudioBase64,
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Visual follow-up request failed.',
    });
  }
};
