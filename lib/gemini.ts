const ANALYSIS_MODEL = 'gemini-2.5-flash';

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

const ANALYZE_PROMPT =
  'You are Ved, a camera assistant. The user has shared one camera frame and a direct question. ' +
  'Return only JSON. Use keys answerText, sceneSummary, annotations, focusX, focusY, focusLabel, cameraZoom, and notebook. ' +
  'answerText should be short, direct, and spoken-friendly. ' +
  'sceneSummary should be one concise helper sentence for the UI. ' +
  'annotations should be an array of 0 to 2 objects with label, reason, x, y, color, placement, lineWidth, and lineHeight. ' +
  'Only annotate the part that directly answers the question. Never annotate everything visible in the frame. ' +
  'If the user asks what is wrong, what is incorrect, what failed, or what to fix, annotate only the wrong or suspicious part. ' +
  'If the question can be answered without a visual marker, return an empty annotations array. ' +
  'x and y must be normalized values between 0 and 1. ' +
  'color must be one of cyan, amber, coral, mint, lime. placement must be one of left, right, top, or bottom. ' +
  'When the user asks for the correct way, proper working, or a fixed calculation and the math is readable, include notebook with title, intro, steps, and answerLine so the UI can show a notebook popup. Keep notebook null otherwise. ' +
  'The notebook steps should be 2 to 5 short lines showing the corrected working clearly. ' +
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

export async function analyzeFrame(question: string, imageBase64: string) {
  const cleanQuestion = question.replace(/^hey\s+ved[\s,.:;-]*/i, '').trim() || question.trim();

  const payload = await callGemini({
    contents: [
      {
        parts: [
          {
            text: `${ANALYZE_PROMPT}\n\nUser question: ${cleanQuestion}`,
          },
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

  return parseJson<AnalyzeResponse>(extractCandidateText(payload));
}
