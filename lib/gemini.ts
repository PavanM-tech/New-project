const ANALYSIS_MODEL = 'gemini-2.5-flash';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = 'Kore';

export type Annotation = {
  color?: 'cyan' | 'amber' | 'coral' | 'mint' | 'lime';
  label?: string;
  lineHeight?: number;
  lineWidth?: number;
  placement?: 'left' | 'right' | 'top' | 'bottom';
  reason?: string;
  x?: number;
  y?: number;
};

export type NotebookOverlay = {
  answerLine?: string;
  intro?: string;
  steps?: string[];
  title?: string;
};

export type AnalyzeResponse = {
  annotations?: Annotation[];
  answerText?: string;
  cameraZoom?: number;
  focusLabel?: string;
  focusX?: number;
  focusY?: number;
  notebook?: NotebookOverlay | null;
  sceneSummary?: string;
};

export type ConversationTurn = {
  answer?: string;
  question: string;
};

const ANALYZE_PROMPT =
  'You are Ved, a camera assistant and study helper. The user may share a camera frame, or may ask a direct question without any image. ' +
  'Return only JSON. Use keys answerText, sceneSummary, annotations, focusX, focusY, focusLabel, cameraZoom, and notebook. ' +
  'answerText should be short, direct, and spoken-friendly. ' +
  'sceneSummary should be one concise helper sentence for the UI. ' +
  'annotations should be an array of 0 to 2 objects with label, reason, x, y, color, placement, lineWidth, and lineHeight. ' +
  'Only annotate the part that directly answers the question. Never annotate everything visible in the frame. ' +
  'If the user asks what is wrong, what is incorrect, what failed, or what to fix, annotate only the wrong or suspicious part. ' +
  'If the question can be answered without a visual marker, return an empty annotations array. ' +
  'x and y must be normalized values between 0 and 1. ' +
  'color must be one of cyan, amber, coral, mint, lime. placement must be one of left, right, top, or bottom. ' +
  'When the user asks for the correct way, proper working, a step-by-step solution, or a fixed calculation, include notebook with title, intro, steps, and answerLine so the UI can show a notebook popup, even if there is no image, as long as the question itself gives enough context. Keep notebook null otherwise. ' +
  'Use the previous conversation context when the new question is clearly a follow-up like "why", "how", "explain this", "next step", or "what about this line". ' +
  'If notebook context is already active, keep answering inside that same topic unless the user clearly switches subjects. ' +
  'The notebook steps should be 2 to 5 short lines showing the corrected working clearly. ' +
  'If there is no image and the question depends on seeing something, say that clearly and ask the user to open the camera or share the page. ' +
  'If the frame is unclear, ask the user to hold it steady or bring it closer.';

function getApiKey() {
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.EXPO_PUBLIC_GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY on the server.');
  }

  return apiKey;
}

async function callGemini(payload: Record<string, unknown>) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${ANALYSIS_MODEL}:generateContent?key=${getApiKey()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

async function callGeminiTts(payload: Record<string, unknown>) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${getApiKey()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini TTS request failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

function extractCandidateText(payload: Record<string, any>) {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? '')
    .join('');

  if (!text) {
    throw new Error('Gemini did not return a valid analysis payload.');
  }

  return text;
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Gemini response was not valid JSON.');
    }

    return JSON.parse(jsonMatch[0]) as T;
  }
}

export async function analyzeFrame(
  question: string,
  imageBase64?: string | null,
  history: ConversationTurn[] = [],
) {
  const cleanQuestion = question.replace(/^hey\s+ved[\s,.:;-]*/i, '').trim() || question.trim();
  const recentHistory = history
    .slice(-6)
    .map((turn, index) => {
      const questionLine = `Q${index + 1}: ${turn.question}`;
      const answerLine = turn.answer ? `A${index + 1}: ${turn.answer}` : '';
      return [questionLine, answerLine].filter(Boolean).join('\n');
    })
    .join('\n');
  const parts: Array<Record<string, unknown>> = [
    {
      text: `${ANALYZE_PROMPT}\n\nPrevious conversation:\n${recentHistory || 'None'}\n\nUser question: ${cleanQuestion}`,
    },
  ];

  if (imageBase64) {
    parts.push({
      inlineData: {
        data: imageBase64,
        mimeType: 'image/jpeg',
      },
    });
  }

  const payload = await callGemini({
    contents: [
      {
        parts,
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

  return parseJson<AnalyzeResponse>(extractCandidateText(payload));
}

export async function synthesizeSpeech(text: string) {
  const spokenText = addConversationalExpression(text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);

  if (!spokenText) {
    return null;
  }

  const payload = await callGeminiTts({
    contents: [
      {
        parts: [
          {
            text:
              '[warm, expressive, natural, conversational, teacherly, lightly encouraging] ' +
              spokenText,
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

  return payload?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? null;
}

function addConversationalExpression(text: string) {
  const trimmed = text.trim();

  if (!trimmed) {
    return trimmed;
  }

  if (/^(hmm|okay|alright|haa|ah|let me see)/i.test(trimmed)) {
    return trimmed;
  }

  if (/wrong|mistake|error|careful|not quite/i.test(trimmed)) {
    return `Hmm, let me see. ${trimmed}`;
  }

  if (/correct|exactly|yes|right/i.test(trimmed)) {
    return `Haa, now I get it. ${trimmed}`;
  }

  if (/explain|theorem|step|solution|because/i.test(trimmed)) {
    return `Okay, let me walk you through it. ${trimmed}`;
  }

  return `Okay, let me see. ${trimmed}`;
}
