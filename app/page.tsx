'use client';

import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';

type Annotation = {
  color: string;
  id: string;
  label: string;
  lineHeight?: number;
  lineWidth?: number;
  placement?: 'left' | 'right' | 'top' | 'bottom';
  reason: string;
  x: number;
  y: number;
};

type NotebookOverlay = {
  answerLine?: string;
  intro?: string;
  steps: string[];
  title: string;
};

type AnalyzeResponse = {
  annotations?: Array<Partial<Annotation>>;
  answerText?: string;
  cameraZoom?: number;
  focusLabel?: string;
  focusX?: number;
  focusY?: number;
  notebook?: Partial<NotebookOverlay> | null;
  sceneSummary?: string;
};

type SpeechRecognitionConstructor = new () => SpeechRecognition;

type SpeechRecognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<{ 0?: { transcript?: string }; isFinal: boolean }> }) => void) | null;
  start(): void;
  stop(): void;
};

const COLOR_MAP: Record<string, string> = {
  amber: '#F4B942',
  coral: '#FF7A59',
  cyan: '#52D6F4',
  lime: '#B8E54E',
  mint: '#66E5AE',
};

const QUICK_ACTIONS = [
  'What is wrong here?',
  'Check my calculation',
  'Explain this step',
  'Show the correct way',
];

const MAX_ANNOTATIONS = 2;

export default function Page() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const availableVoicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const shouldRestartListeningRef = useRef(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [assistantState, setAssistantState] = useState<'idle' | 'listening' | 'thinking' | 'replying'>('idle');
  const [cameraReady, setCameraReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [manualQuestion, setManualQuestion] = useState('');
  const [notebookOverlay, setNotebookOverlay] = useState<NotebookOverlay | null>(null);
  const [questionText, setQuestionText] = useState('');
  const [sceneSummary, setSceneSummary] = useState(
    'Open the camera, ask a question, and Ved will only inspect the part that matters.',
  );
  const [supportsSpeech, setSupportsSpeech] = useState(false);
  const [transcriptPreview, setTranscriptPreview] = useState('');
  const [voiceReady, setVoiceReady] = useState(false);

  useEffect(() => {
    const SpeechRecognitionCtor =
      (window as typeof window & {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
      }).SpeechRecognition ||
      (window as typeof window & {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
      }).webkitSpeechRecognition;

    setSupportsSpeech(Boolean(SpeechRecognitionCtor));

    if (!SpeechRecognitionCtor) {
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-IN';

    recognition.onresult = (event) => {
      let transcript = '';

      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript ?? '';
      }

      const cleaned = transcript.trim();
      setTranscriptPreview(cleaned);

      const lastResult = event.results[event.results.length - 1];

      if (lastResult?.isFinal && cleaned) {
        setQuestionText(cleaned);
        void askVed(cleaned);
      }
    };

    recognition.onerror = (event) => {
      setErrorMessage(event.error === 'no-speech' ? 'I did not catch that.' : `Voice input error: ${event.error}`);
      setAssistantState('idle');
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      if (shouldRestartListeningRef.current) {
        startListening();
      }
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    const updateVoices = () => {
      availableVoicesRef.current = window.speechSynthesis.getVoices();
      setVoiceReady(availableVoicesRef.current.length > 0);
    };

    updateVoices();
    window.speechSynthesis.addEventListener('voiceschanged', updateVoices);

    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', updateVoices);
    };
  }, []);

  const stateLabel = useMemo(() => {
    switch (assistantState) {
      case 'listening':
        return 'Listening';
      case 'thinking':
        return 'Thinking';
      case 'replying':
        return 'Replying';
      case 'idle':
      default:
        return 'Ready';
    }
  }, [assistantState]);

  async function startCamera() {
    try {
      setErrorMessage(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      if (!videoRef.current) {
        return;
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraReady(true);
      setSceneSummary('Camera is ready. Ask Ved about anything you want checked.');
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Camera access could not be started.',
      );
    }
  }

  function captureFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      throw new Error('Camera frame is not ready yet.');
    }

    const targetWidth = 960;
    const targetHeight = Math.round((video.videoHeight / video.videoWidth) * targetWidth);
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('Canvas capture is not available.');
    }

    context.drawImage(video, 0, 0, targetWidth, targetHeight);

    return canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
  }

  function normalizeAnnotations(response: AnalyzeResponse) {
    const rawAnnotations = Array.isArray(response.annotations) ? response.annotations : [];

    return rawAnnotations.slice(0, MAX_ANNOTATIONS).map((item, index) => {
      const colorKey = typeof item.color === 'string' ? item.color.toLowerCase() : 'cyan';

      return {
        color: COLOR_MAP[colorKey] ?? COLOR_MAP.cyan,
        id: `${Date.now()}-${index}`,
        label:
          typeof item.label === 'string' && item.label.trim()
            ? item.label.trim().slice(0, 40)
            : `Target ${index + 1}`,
        lineHeight: clampNumber(item.lineHeight, 44, 18, 120),
        lineWidth: clampNumber(item.lineWidth, 88, 40, 170),
        placement: normalizePlacement(item.placement),
        reason:
          typeof item.reason === 'string' && item.reason.trim()
            ? item.reason.trim()
            : 'Relevant to your question.',
        x: clampNumber(item.x, 0.5, 0.06, 0.94),
        y: clampNumber(item.y, 0.5, 0.08, 0.88),
      } satisfies Annotation;
    });
  }

  function normalizeNotebookOverlay(notebook: AnalyzeResponse['notebook']) {
    if (!notebook || !Array.isArray(notebook.steps) || notebook.steps.length === 0) {
      return null;
    }

    return {
      answerLine:
        typeof notebook.answerLine === 'string' && notebook.answerLine.trim()
          ? notebook.answerLine.trim()
          : undefined,
      intro:
        typeof notebook.intro === 'string' && notebook.intro.trim()
          ? notebook.intro.trim()
          : undefined,
      steps: notebook.steps
        .map((step) => (typeof step === 'string' ? step.trim() : ''))
        .filter(Boolean)
        .slice(0, 6),
      title:
        typeof notebook.title === 'string' && notebook.title.trim()
          ? notebook.title.trim()
          : 'Correct way',
    } satisfies NotebookOverlay;
  }

  async function askVed(inputQuestion: string) {
    const cleanedQuestion = inputQuestion.trim();

    if (!cleanedQuestion) {
      return;
    }

    try {
      setErrorMessage(null);
      setNotebookOverlay(null);
      setAssistantState('thinking');
      setQuestionText(cleanedQuestion);
      setSceneSummary(
        cameraReady
          ? 'Ved is checking only the relevant part of the frame.'
          : 'Ved is answering from your question and can open a notebook view without the camera.',
      );

      const imageBase64 = cameraReady ? captureFrame() : undefined;
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          imageBase64,
          question: cleanedQuestion,
        }),
      });

      const payload = (await response.json()) as { error?: string; result?: AnalyzeResponse };

      if (!response.ok || !payload.result) {
        throw new Error(payload.error || 'Ved could not analyze the frame.');
      }

      const result = payload.result;
      const answerText =
        result.answerText?.trim() ||
        (cameraReady
          ? 'I need a slightly clearer view to answer that well.'
          : 'I can help with that, but I need a little more detail from your question.');
      const summaryText =
        result.sceneSummary?.trim() ||
        (cameraReady
          ? 'Ved answered using the current camera frame.'
          : 'Ved answered directly from your question.');

      setAnnotations(normalizeAnnotations(result));
      setNotebookOverlay(normalizeNotebookOverlay(result.notebook));
      setSceneSummary(summaryText);
      setAssistantState('replying');
      void speakAnswer(answerText, () => setAssistantState('idle'));
    } catch (error) {
      setAssistantState('idle');
      setErrorMessage(
        error instanceof Error ? error.message : 'Ved could not answer that.',
      );
    }
  }

  async function speakAnswer(answerText: string, onDone: () => void) {
    try {
      const response = await fetch('/api/speak', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: answerText }),
      });

      const payload = (await response.json()) as { audioBase64?: string; error?: string };

      if (response.ok && payload.audioBase64) {
        await playPremiumAudio(payload.audioBase64, onDone);
        return;
      }
    } catch {
      // Fall back to browser speech below.
    }

    playBrowserSpeech(answerText, onDone);
  }

  function playBrowserSpeech(answerText: string, onDone: () => void) {
    window.speechSynthesis.cancel();
    const chunks = humanizeForSpeech(answerText);
    const voice = chooseBestVoice(availableVoicesRef.current);

    if (chunks.length === 0) {
      onDone();
      return;
    }

    let index = 0;

    const speakNext = () => {
      if (index >= chunks.length) {
        onDone();
        return;
      }

      const chunk = chunks[index];
      const utterance = new SpeechSynthesisUtterance(chunk.text);

      if (voice) {
        utterance.voice = voice;
      }

      utterance.lang = voice?.lang || 'en-IN';
      utterance.rate = chunk.rate;
      utterance.pitch = chunk.pitch;
      utterance.volume = 1;
      utterance.onend = () => {
        index += 1;
        speakNext();
      };
      utterance.onerror = () => {
        index += 1;
        speakNext();
      };

      window.speechSynthesis.speak(utterance);
    };

    speakNext();
  }

  async function playPremiumAudio(audioBase64: string, onDone: () => void) {
    window.speechSynthesis.cancel();

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    const wavBlob = pcmBase64ToWavBlob(audioBase64, 24000, 1, 16);
    const audioUrl = URL.createObjectURL(wavBlob);
    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      audioRef.current = null;
      onDone();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      audioRef.current = null;
      onDone();
    };
    await audio.play();
  }

  function startListening() {
    if (!recognitionRef.current) {
      setErrorMessage('Voice input is not supported on this browser. Use the quick actions or type your question.');
      return;
    }

    shouldRestartListeningRef.current = false;
    setTranscriptPreview('');
    setErrorMessage(null);
    setIsListening(true);
    setAssistantState('listening');
    recognitionRef.current.start();
  }

  function stopListening() {
    shouldRestartListeningRef.current = false;
    recognitionRef.current?.stop();
    setIsListening(false);
    setAssistantState('idle');
  }

  function submitManualQuestion() {
    void askVed(manualQuestion);
    setManualQuestion('');
  }

  return (
    <main className="app-shell">
      <section className="hero-shell">
        <div className="viewer-shell">
          <div className="camera-shell">
            <video className="camera-feed" muted playsInline ref={videoRef} />
            <canvas className="hidden-canvas" ref={canvasRef} />

            <div className="annotation-layer">
              {annotations.map((annotation) => (
                <div
                  className={`annotation-wrap annotation-${annotation.placement}`}
                  key={annotation.id}
                  style={{
                    left: `${annotation.x * 100}%`,
                    top: `${annotation.y * 100}%`,
                  }}
                >
                  <div className="annotation-anchor">
                    <span
                      className="annotation-dot"
                      style={{ borderColor: `${annotation.color}BB`, backgroundColor: annotation.color }}
                    />
                    <span
                      className="annotation-line"
                      style={{
                        borderColor: `${annotation.color}99`,
                        ['--line-height' as string]: `${annotation.lineHeight ?? 44}px`,
                        ['--line-width' as string]: `${annotation.lineWidth ?? 88}px`,
                      }}
                    />
                  </div>
                  <div className="annotation-card">
                    <strong>{annotation.label}</strong>
                    <span>{annotation.reason}</span>
                  </div>
                </div>
              ))}
            </div>

            {!cameraReady ? (
              <button className="camera-cta" onClick={() => void startCamera()} type="button">
                Open camera
              </button>
            ) : null}
          </div>

          <aside className="control-panel">
            <div className="logo-stack">
              <div className={`logo-orb logo-${assistantState}`}>
                <div className="logo-ring logo-ring-one" />
                <div className="logo-ring logo-ring-two" />
                <Image
                  alt="Ved logo"
                  className="logo-mark"
                  height={84}
                  priority
                  src="/ved-logo.png"
                  width={84}
                />
              </div>
              <div>
                <p className="eyebrow">Ved</p>
                <h1>Camera help that answers faster.</h1>
                <p className="status-copy">
                  {stateLabel}. {sceneSummary}
                </p>
              </div>
            </div>

            <div className="action-row">
              {supportsSpeech ? (
                isListening ? (
                  <button className="primary-button danger-button" onClick={stopListening} type="button">
                    Stop listening
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    disabled={!cameraReady && !voiceReady}
                    onClick={startListening}
                    type="button"
                  >
                    Ask out loud
                  </button>
                )
              ) : null}
              <button
                className="secondary-button"
                disabled={!cameraReady}
                onClick={() => setIsPanelOpen((current) => !current)}
                type="button"
              >
                {isPanelOpen ? 'Hide panel' : 'Show panel'}
              </button>
            </div>

            {transcriptPreview ? (
              <p className="transcript-preview">Heard: {transcriptPreview}</p>
            ) : null}

            <div className="quick-actions">
              {QUICK_ACTIONS.map((action) => (
                <button
                  className="chip"
                  key={action}
                  onClick={() => void askVed(action)}
                  type="button"
                >
                  {action}
                </button>
              ))}
            </div>

            <div className="manual-ask">
              <label htmlFor="manual-question">Or type what you want Ved to inspect</label>
              <div className="manual-row">
                <input
                  id="manual-question"
                  onChange={(event) => setManualQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      submitManualQuestion();
                    }
                  }}
                  placeholder="For example: what is wrong in this equation?"
                  value={manualQuestion}
                />
                <button
                  className="primary-button compact-button"
                  disabled={!manualQuestion.trim()}
                  onClick={submitManualQuestion}
                  type="button"
                >
                  Ask
                </button>
              </div>
            </div>

            {errorMessage ? <p className="error-copy">{errorMessage}</p> : null}

            {isPanelOpen ? (
              <div className="panel-card">
                <p className="panel-label">Last question</p>
                <p className="panel-value">{questionText || 'Nothing asked yet.'}</p>
                <p className="panel-label">What Ved is doing</p>
                <p className="panel-meta">
                  {assistantState === 'listening'
                    ? 'Listening to your question.'
                    : assistantState === 'thinking'
                      ? cameraReady
                        ? 'Checking the current frame only for what you asked.'
                        : 'Answering from your question and opening notebook help when useful.'
                    : assistantState === 'replying'
                        ? 'Replying with a more natural voice and falling back locally if needed.'
                        : 'Ready for the next question.'}
                </p>
              </div>
            ) : null}
          </aside>
        </div>
      </section>

      {notebookOverlay ? (
        <div
          className="notebook-backdrop"
          onClick={() => setNotebookOverlay(null)}
          role="presentation"
        >
          <div
            className="notebook-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={notebookOverlay.title}
          >
            <div className="notebook-header">
              <h2>{notebookOverlay.title}</h2>
              <button
                className="secondary-button compact-button notebook-close"
                onClick={() => setNotebookOverlay(null)}
                type="button"
              >
                Close
              </button>
            </div>
            <div className="notebook-paper">
              {Array.from({ length: 7 }).map((_, index) => (
                <span className="notebook-rule" key={index} style={{ top: `${72 + index * 42}px` }} />
              ))}
              <span className="notebook-margin" />
              {notebookOverlay.intro ? <p className="notebook-intro">{notebookOverlay.intro}</p> : null}
              <div className="notebook-steps">
                {notebookOverlay.steps.map((step, index) => (
                  <p
                    className="notebook-step"
                    key={`${step}-${index}`}
                    style={{ transform: `rotate(${index % 2 === 0 ? -1.4 : 1.2}deg)` }}
                  >
                    {step}
                  </p>
                ))}
              </div>
              {notebookOverlay.answerLine ? (
                <p className="notebook-answer">{notebookOverlay.answerLine}</p>
              ) : null}
            </div>
            <div className="notebook-follow-up">
              <label htmlFor="notebook-follow-up">Ask a follow-up about this working</label>
              <div className="manual-row">
                <input
                  id="notebook-follow-up"
                  onChange={(event) => setManualQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      submitManualQuestion();
                    }
                  }}
                  placeholder="For example: why is this step wrong?"
                  value={manualQuestion}
                />
                <button
                  className="primary-button compact-button"
                  disabled={!manualQuestion.trim()}
                  onClick={submitManualQuestion}
                  type="button"
                >
                  Ask
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizePlacement(value: unknown): Annotation['placement'] {
  if (value === 'left' || value === 'right' || value === 'top' || value === 'bottom') {
    return value;
  }

  return 'right';
}

function chooseBestVoice(voices: SpeechSynthesisVoice[]) {
  if (voices.length === 0) {
    return null;
  }

  const ranked = [...voices].sort((left, right) => scoreVoice(right) - scoreVoice(left));
  return ranked[0] ?? null;
}

function scoreVoice(voice: SpeechSynthesisVoice) {
  const name = voice.name.toLowerCase();
  const lang = voice.lang.toLowerCase();
  let score = 0;

  if (lang.includes('en-in')) score += 6;
  else if (lang.startsWith('en')) score += 4;

  if (voice.localService) score += 2;
  if (name.includes('natural')) score += 4;
  if (name.includes('neural')) score += 4;
  if (name.includes('premium')) score += 3;
  if (name.includes('enhanced')) score += 3;
  if (name.includes('google')) score += 2;
  if (name.includes('microsoft')) score += 2;
  if (name.includes('female')) score += 1;
  if (name.includes('zira') || name.includes('aria') || name.includes('samantha') || name.includes('moira')) score += 3;

  return score;
}

function humanizeForSpeech(text: string) {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/\bVed\b/g, 'Ved,')
    .trim();

  return cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence, index, array) => {
      const trimmed = sentence.trim();

      if (!trimmed) {
        return null;
      }

      const energetic = /great|nice|correct|exactly|yes|perfect/i.test(trimmed);
      const cautious = /check|careful|wrong|mistake|error|unclear/i.test(trimmed);
      const isLast = index === array.length - 1;

      return {
        text: ensureSpeechPunctuation(trimmed, isLast),
        rate: cautious ? 0.94 : energetic ? 1.02 : 0.98,
        pitch: energetic ? 1.08 : cautious ? 0.96 : 1.01,
      };
    })
    .filter(Boolean) as Array<{ pitch: number; rate: number; text: string }>;
}

function ensureSpeechPunctuation(sentence: string, isLast: boolean) {
  if (/[.!?]$/.test(sentence)) {
    return sentence;
  }

  return `${sentence}${isLast ? '.' : ','}`;
}

function pcmBase64ToWavBlob(
  pcmBase64: string,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
) {
  const pcmBytes = Uint8Array.from(atob(pcmBase64), (char) => char.charCodeAt(0));
  const wavBuffer = new ArrayBuffer(44 + pcmBytes.length);
  const view = new DataView(wavBuffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * channels * bitsPerSample) / 8, true);
  view.setUint16(32, (channels * bitsPerSample) / 8, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcmBytes.length, true);

  new Uint8Array(wavBuffer, 44).set(pcmBytes);

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
