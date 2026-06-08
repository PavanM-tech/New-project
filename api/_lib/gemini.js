const ANALYSIS_MODEL = 'gemini-2.5-flash';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = 'Kore';

const VOICE_SCENE_PROMPT =
  'You are Ved, a camera assistant. The user has sent a photo and a short voice question. ' +
  'Transcribe the spoken question, ignore a leading wake phrase like "Hey Ved" if present, ' +
  'answer in one very short spoken sentence whenever possible, and return only JSON. ' +
  'Use keys spokenPrompt, answerText, sceneSummary, followUpMode, followUpPrompt, focusX, focusY, focusLabel, cameraZoom, annotations, and notebook. ' +
  'sceneSummary should be one concise sentence. ' +
  'annotations should be an array of up to 3 objects with label, reason, x, y, color, placement, lineWidth, and lineHeight. ' +
  'notebook should be null unless the user asks for the correct way, the proper working, the step-by-step solution, or how to fix a wrong calculation. ' +
  'When notebook is present, set it to an object with title, intro, steps, and answerLine. Use the title "Correct way" unless the user clearly asks for a different label. steps should have 2 to 5 short handwritten-style lines that show the correct working clearly. If the user asks for the correct way after showing a wrong calculation, always include notebook. ' +
  'x and y must be normalized values between 0 and 1. ' +
  'color must be one of cyan, amber, coral, mint, lime. ' +
  'placement must be one of left, right, top, or bottom and describes where the callout card should sit relative to the target point. ' +
  'Only annotate the specific region that answers the user question or shows the likely issue. Never annotate every visible object. ' +
  'If the user asks what is wrong, what is incorrect, what failed, or what to fix, annotate only the wrong or suspicious parts. ' +
  'When a specific object, line, equation, or region is important, include focusX, focusY, a short focusLabel, and cameraZoom between 0 and 0.7 so the app can emphasize that region. ' +
  'Keep answerText natural and conversational for spoken playback, but short enough to speak quickly. ' +
  'If the user asks to check a notebook, homework, calculation, equation, or math answer and the image does not clearly show readable math, set followUpMode to "show_notebook_math", set followUpPrompt to a short instruction asking them to show the notebook clearly, and keep answerText aligned with that request. ' +
  'If the math is visible and readable, set followUpMode to "none" and solve or explain it briefly.';

const NOTEBOOK_FOLLOW_UP_PROMPT =
  'You are Ved, a camera tutor. Look for a notebook page, handwritten math, printed equations, or calculations. ' +
  'If the math is visible and readable, return JSON with resolved=true, a concise sceneSummary, a very short spoken answerText, focusX, focusY, focusLabel, cameraZoom, annotations, and notebook. ' +
  'Use at most 3 annotations. Each annotation should include label, reason, x, y, color, placement, lineWidth, and lineHeight. ' +
  'If the user is asking for the correct way, proper working, or fixed calculation, set notebook to an object with title, intro, steps, and answerLine so the app can render a handwritten notebook popup. Use the title "Correct way". In that case, always include notebook when the math is readable. Otherwise set notebook to null. ' +
  'Use transparent callout-style placements like left, right, top, or bottom. ' +
  'If the notebook or math is not yet readable, return resolved=false with a short sceneSummary telling the user to bring the notebook closer, flatter, and steadier. Return only JSON.';

function getApiKey() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY on the server.');
  }

  return apiKey;
}

async function callGemini(model, payload) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getApiKey()}`,
    {
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

function extractCandidateText(payload) {
  return payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? '')
    .join('');
}

function parseGeminiJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Gemini response was not valid JSON.');
    }

    return JSON.parse(jsonMatch[0]);
  }
}

async function synthesizeSpeech(text) {
  if (!text) {
    return undefined;
  }

  const conciseText = makeSpeechConcise(text);

  const payload = await callGemini(TTS_MODEL, {
    contents: [
      {
        parts: [
          {
            text: `[friendly, helpful] ${conciseText}`,
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

  return payload?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
}

function makeSpeechConcise(text) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  const firstSentence = normalized.match(/[^.!?]+[.!?]?/)?.[0]?.trim() ?? normalized;

  if (firstSentence.length <= 120) {
    return firstSentence;
  }

  return `${firstSentence.slice(0, 117).trim()}...`;
}

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function readJsonBody(req) {
  if (typeof req.body === 'string') {
    return JSON.parse(req.body);
  }

  return req.body ?? {};
}

function handleMethod(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return false;
  }

  return true;
}

module.exports = {
  ANALYSIS_MODEL,
  NOTEBOOK_FOLLOW_UP_PROMPT,
  TTS_MODEL,
  TTS_VOICE,
  VOICE_SCENE_PROMPT,
  callGemini,
  extractCandidateText,
  handleMethod,
  parseGeminiJson,
  readJsonBody,
  sendJson,
  synthesizeSpeech,
  makeSpeechConcise,
};
