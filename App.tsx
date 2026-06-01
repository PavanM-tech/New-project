import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';

type Annotation = {
  color: string;
  confidence: number;
  id: string;
  label: string;
  reason: string;
  x: number;
  y: number;
};

type FocusGuide = {
  label?: string;
  x: number;
  y: number;
  zoom: number;
};

type VoiceSceneResponse = {
  annotations?: Array<Partial<Annotation>>;
  answerText?: string;
  cameraZoom?: number;
  focusLabel?: string;
  followUpMode?: 'none' | 'show_notebook_math';
  followUpPrompt?: string;
  focusX?: number;
  focusY?: number;
  sceneSummary?: string;
  spokenPrompt?: string;
};

type VisualFollowUpResponse = {
  annotations?: Array<Partial<Annotation>>;
  answerText?: string;
  cameraZoom?: number;
  focusLabel?: string;
  focusX?: number;
  focusY?: number;
  resolved?: boolean;
  sceneSummary?: string;
};

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
const ANALYSIS_MODEL = 'gemini-2.5-flash';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = 'Kore';
const MAX_ANNOTATIONS = 5;
const AUTO_STOP_SILENCE_MS = 1200;
const MIN_RECORDING_MS = 900;
const SPEECH_METERING_THRESHOLD = -38;
const MAX_RECORDING_MS = 12000;
const FOLLOW_UP_SCAN_INTERVAL_MS = 2400;
const COLOR_MAP: Record<string, string> = {
  amber: '#F4B942',
  coral: '#FF7A59',
  cyan: '#52D6F4',
  lime: '#B8E54E',
  mint: '#66E5AE',
};

export default function App() {
  const cameraRef = useRef<CameraView | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const stopVoiceCaptureRef = useRef<() => Promise<void>>(async () => undefined);
  const silenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visualScanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isVisualScanInFlightRef = useRef(false);
  const hasHeardSpeechRef = useRef(false);
  const isStoppingRef = useRef(false);
  const isAutoStartingRef = useRef(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = Audio.usePermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraZoom, setCameraZoom] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [sceneSummary, setSceneSummary] = useState(
    'Ved is always listening while this app is open. Say "Hey Ved..." and pause when you are done.',
  );
  const [statusLine, setStatusLine] = useState('Ready');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [recordingMillis, setRecordingMillis] = useState(0);
  const [appState, setAppState] = useState(AppState.currentState);
  const [pendingFollowUpMode, setPendingFollowUpMode] = useState<'show_notebook_math' | null>(null);
  const [followUpPrompt, setFollowUpPrompt] = useState<string | null>(null);
  const [focusGuide, setFocusGuide] = useState<FocusGuide | null>(null);

  const canStartListening = useMemo(
    () =>
      Boolean(
        cameraPermission?.granted &&
          cameraReady &&
          cameraRef.current &&
          !isBusy &&
          !isRecording,
      ),
    [cameraPermission?.granted, cameraReady, isBusy, isRecording],
  );

  const normalizeAnnotations = useCallback((response: VoiceSceneResponse): Annotation[] => {
    const rawAnnotations = Array.isArray(response.annotations) ? response.annotations : [];

    return rawAnnotations.slice(0, MAX_ANNOTATIONS).map((item, index) => {
      const colorKey = typeof item.color === 'string' ? item.color.toLowerCase() : 'cyan';

      return {
        color: COLOR_MAP[colorKey] ?? COLOR_MAP.cyan,
        confidence: clampNumber(item.confidence, 0.25, 0, 1),
        id: `${Date.now()}-${index}`,
        label: sanitizeLabel(item.label, index),
        reason:
          typeof item.reason === 'string' && item.reason.trim()
            ? item.reason.trim()
            : 'Detected by Ved.',
        x: clampNumber(item.x, 0.5, 0.05, 0.95),
        y: clampNumber(item.y, 0.5, 0.08, 0.9),
      };
    });
  }, []);

  const normalizeFocusGuide = useCallback((response: VoiceSceneResponse | VisualFollowUpResponse) => {
    const x = clampNumber(
      'focusX' in response ? response.focusX : undefined,
      Number.NaN,
      0.05,
      0.95,
    );
    const y = clampNumber(
      'focusY' in response ? response.focusY : undefined,
      Number.NaN,
      0.08,
      0.9,
    );

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return {
      label:
        'focusLabel' in response && typeof response.focusLabel === 'string'
          ? response.focusLabel.trim()
          : undefined,
      x,
      y,
      zoom: clampNumber(
        'cameraZoom' in response ? response.cameraZoom : undefined,
        0.18,
        0,
        0.7,
      ),
    } satisfies FocusGuide;
  }, []);

  useEffect(() => {
    return () => {
      clearSilenceTimer(silenceTimeoutRef);
      clearSilenceTimer(restartTimeoutRef);
      clearIntervalIfPresent(visualScanIntervalRef);
      void stopSoundPlayback(soundRef);
      if (recordingRef.current) {
        void recordingRef.current.stopAndUnloadAsync().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);

    return () => {
      subscription.remove();
    };
  }, []);

  const stopVoiceCapture = useCallback(async () => {
    if (!recordingRef.current || !cameraRef.current || isStoppingRef.current) {
      return;
    }

    try {
      isStoppingRef.current = true;
      clearSilenceTimer(silenceTimeoutRef);
      setIsRecording(false);
      setIsBusy(true);
      setErrorMessage(null);
      setStatusLine('Thinking');

      const recording = recordingRef.current;
      recordingRef.current = null;

      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        playThroughEarpieceAndroid: false,
      });

      const recordingUri = recording.getURI();
      if (!recordingUri) {
        throw new Error('The recorded audio could not be read.');
      }

      const [audioBase64, photo] = await Promise.all([
        FileSystem.readAsStringAsync(recordingUri, {
          encoding: FileSystem.EncodingType.Base64,
        }),
        cameraRef.current.takePictureAsync({
          base64: true,
          quality: 0.35,
          skipProcessing: true,
        }),
      ]);

      if (!photo.base64) {
        throw new Error('Camera capture did not include base64 image data.');
      }

      const voiceResult = await requestVoiceSceneTurn({
        apiKey: API_KEY ?? '',
        audioBase64,
        audioMimeType: getAudioMimeType(),
        imageBase64: photo.base64,
      });

      const parsedAnnotations = normalizeAnnotations(voiceResult);
      const followUpMode =
        voiceResult.followUpMode === 'show_notebook_math'
          ? 'show_notebook_math'
          : null;
      const focus = normalizeFocusGuide(voiceResult);
      const resolvedAnswer =
        voiceResult.answerText?.trim() ||
        voiceResult.sceneSummary?.trim() ||
        'I can see the scene, but I need a clearer question to answer well.';

      setAnnotations(parsedAnnotations);
      setPendingFollowUpMode(followUpMode);
      setFollowUpPrompt(
        followUpMode
          ? voiceResult.followUpPrompt?.trim() || 'Show me your notebook clearly so I can read the math.'
          : null,
      );
      setFocusGuide(focus);
      setCameraZoom(focus?.zoom ?? 0);
      setSceneSummary(
        (followUpMode
          ? voiceResult.followUpPrompt?.trim()
          : voiceResult.sceneSummary?.trim()) ||
          'Ved updated the markers and answered out loud.',
      );
      setStatusLine('Speaking');

      await speakWithGemini({
        apiKey: API_KEY ?? '',
        soundRef,
        text: resolvedAnswer,
        onStart: () => setIsSpeaking(true),
        onDone: () => {
          setIsSpeaking(false);
          setStatusLine('Ready');
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ved could not answer that voice request.';
      setErrorMessage(message);
      setStatusLine('Listening will resume');
      setIsSpeaking(false);
    } finally {
      isStoppingRef.current = false;
      hasHeardSpeechRef.current = false;
      setIsBusy(false);
      setRecordingMillis(0);
    }
  }, [normalizeAnnotations]);

  useEffect(() => {
    stopVoiceCaptureRef.current = stopVoiceCapture;
  }, [stopVoiceCapture]);

  const startVoiceCapture = useCallback(async () => {
    if (!API_KEY) {
      Alert.alert(
        'Gemini key missing',
        'Add EXPO_PUBLIC_GEMINI_API_KEY to your environment before running the app.',
      );
      return;
    }

    if (!cameraRef.current || !canStartListening) {
      return;
    }

    const permissionResponse = micPermission?.granted
      ? micPermission
      : await requestMicPermission();

    if (!permissionResponse.granted) {
      Alert.alert(
        'Microphone permission required',
        'Ved needs microphone access so you can ask questions out loud.',
      );
      return;
    }

    try {
      isAutoStartingRef.current = true;
      setErrorMessage(null);
      setStatusLine('Listening');
      setRecordingMillis(0);
      setIsPanelOpen(true);
      hasHeardSpeechRef.current = false;
      isStoppingRef.current = false;
      clearSilenceTimer(silenceTimeoutRef);
      await stopSoundPlayback(soundRef);

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        playThroughEarpieceAndroid: false,
      });

      const recording = new Audio.Recording();
      recording.setOnRecordingStatusUpdate((status) => {
        if ('durationMillis' in status && typeof status.durationMillis === 'number') {
          setRecordingMillis(status.durationMillis);

          const metering =
            'metering' in status && typeof status.metering === 'number'
              ? status.metering
              : null;

          if (metering !== null && metering > SPEECH_METERING_THRESHOLD) {
            hasHeardSpeechRef.current = true;
            clearSilenceTimer(silenceTimeoutRef);
          }

          if (
            hasHeardSpeechRef.current &&
            metering !== null &&
            metering <= SPEECH_METERING_THRESHOLD &&
            status.durationMillis > MIN_RECORDING_MS &&
            !silenceTimeoutRef.current &&
            !isStoppingRef.current
          ) {
            silenceTimeoutRef.current = setTimeout(() => {
              silenceTimeoutRef.current = null;
              void stopVoiceCaptureRef.current();
            }, AUTO_STOP_SILENCE_MS);
          }

          if (
            status.durationMillis >= MAX_RECORDING_MS &&
            !isStoppingRef.current
          ) {
            void stopVoiceCaptureRef.current();
          }
        }
      });
      recording.setProgressUpdateInterval(120);
      await recording.prepareToRecordAsync(getRecordingOptions());
      await recording.startAsync();

      recordingRef.current = recording;
      setIsRecording(true);
    } catch (error) {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        playThroughEarpieceAndroid: false,
      }).catch(() => undefined);

      const message =
        error instanceof Error ? error.message : 'Recording could not be started.';
      setErrorMessage(message);
      setStatusLine('Mic error');
      setIsRecording(false);
    } finally {
      isAutoStartingRef.current = false;
    }
  }, [canStartListening, micPermission, requestMicPermission]);

  useEffect(() => {
    if (!cameraPermission?.granted || !cameraReady || appState !== 'active') {
      return;
    }

    if (micPermission && !micPermission.granted && micPermission.canAskAgain) {
      void requestMicPermission();
    }
  }, [
    appState,
    cameraPermission?.granted,
    cameraReady,
    micPermission,
    requestMicPermission,
  ]);

  useEffect(() => {
    if (
      appState !== 'active' ||
      !cameraPermission?.granted ||
      !micPermission?.granted ||
      !cameraReady ||
      !cameraRef.current ||
      isBusy ||
      isSpeaking ||
      isRecording ||
      pendingFollowUpMode !== null ||
      isAutoStartingRef.current
    ) {
      clearSilenceTimer(restartTimeoutRef);
      return;
    }

    if (restartTimeoutRef.current) {
      return;
    }

    restartTimeoutRef.current = setTimeout(() => {
      restartTimeoutRef.current = null;
      void startVoiceCapture();
    }, 500);

    return () => clearSilenceTimer(restartTimeoutRef);
  }, [
    appState,
    cameraPermission?.granted,
    micPermission?.granted,
    cameraReady,
    isBusy,
    isRecording,
    isSpeaking,
    pendingFollowUpMode,
    startVoiceCapture,
  ]);

  const runVisualFollowUpScan = useCallback(async () => {
    if (
      !pendingFollowUpMode ||
      !cameraRef.current ||
      isVisualScanInFlightRef.current ||
      isBusy ||
      isSpeaking ||
      isRecording
    ) {
      return;
    }

    try {
      isVisualScanInFlightRef.current = true;
      setStatusLine('Looking for your notebook');

      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.4,
        skipProcessing: true,
      });

      if (!photo.base64) {
        throw new Error('Camera capture did not include base64 image data.');
      }

      const followUpResult = await requestVisualFollowUp({
        apiKey: API_KEY ?? '',
        imageBase64: photo.base64,
        mode: pendingFollowUpMode,
      });

      if (!followUpResult.resolved) {
        setFocusGuide(null);
        setCameraZoom(0);
        setSceneSummary(
          followUpPrompt ||
            followUpResult.sceneSummary?.trim() ||
            'Bring the notebook closer and keep it steady.',
        );
        return;
      }

      setAnnotations(normalizeAnnotations(followUpResult));
      const followUpFocus = normalizeFocusGuide(followUpResult);
      setPendingFollowUpMode(null);
      setFollowUpPrompt(null);
      setFocusGuide(followUpFocus);
      setCameraZoom(followUpFocus?.zoom ?? 0.12);
      setSceneSummary(
        followUpResult.sceneSummary?.trim() ||
          'Ved found the notebook and is explaining the math now.',
      );
      setStatusLine('Speaking');

      await speakWithGemini({
        apiKey: API_KEY ?? '',
        soundRef,
        text:
          followUpResult.answerText?.trim() ||
          'I can see the notebook now, but I need a clearer frame to explain the math well.',
        onStart: () => setIsSpeaking(true),
        onDone: () => {
          setIsSpeaking(false);
          setStatusLine('Ready');
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ved could not scan the notebook yet.';
      setErrorMessage(message);
      setStatusLine('Waiting for a clearer notebook view');
    } finally {
      isVisualScanInFlightRef.current = false;
    }
  }, [
    followUpPrompt,
    isBusy,
    isRecording,
    isSpeaking,
    normalizeFocusGuide,
    normalizeAnnotations,
    pendingFollowUpMode,
  ]);

  useEffect(() => {
    if (
      !pendingFollowUpMode ||
      appState !== 'active' ||
      !cameraPermission?.granted ||
      !cameraReady
    ) {
      clearIntervalIfPresent(visualScanIntervalRef);
      return;
    }

    void runVisualFollowUpScan();
    visualScanIntervalRef.current = setInterval(() => {
      void runVisualFollowUpScan();
    }, FOLLOW_UP_SCAN_INTERVAL_MS);

    return () => clearIntervalIfPresent(visualScanIntervalRef);
  }, [
    appState,
    cameraPermission?.granted,
    cameraReady,
    pendingFollowUpMode,
    runVisualFollowUpScan,
  ]);

  if (!cameraPermission) {
    return (
      <CenteredState
        actionLabel="Request Camera Access"
        description="Preparing the camera permission flow..."
        onPress={() => {
          void requestCameraPermission();
        }}
        title="Camera setup"
      />
    );
  }

  if (!cameraPermission.granted) {
    return (
      <CenteredState
        actionLabel="Allow Camera"
        description="This prototype needs live camera access so Ved can see what you are asking about."
        onPress={() => {
          void requestCameraPermission();
        }}
        title="Camera permission required"
      />
    );
  }

  if (micPermission && !micPermission.granted && !micPermission.canAskAgain) {
    return (
      <CenteredState
        actionLabel="Enable Microphone"
        description="Ved needs microphone access for always-listening voice mode. Please enable the microphone in app settings and reopen the app."
        onPress={() => {
          void requestMicPermission();
        }}
        title="Microphone permission required"
      />
    );
  }

  return (
    <View style={styles.appShell}>
      <StatusBar style="light" />
      <CameraView
        ref={cameraRef}
        animateShutter={false}
        facing="back"
        onCameraReady={() => setCameraReady(true)}
        style={StyleSheet.absoluteFill}
        zoom={cameraZoom}
      />

      <View pointerEvents="none" style={styles.annotationLayer}>
        {focusGuide ? (
          <View
            style={[
              styles.focusGuide,
              {
                left: `${focusGuide.x * 100}%`,
                top: `${focusGuide.y * 100}%`,
              },
            ]}
          >
            <View style={styles.focusGuideRing} />
            {focusGuide.label ? (
              <View style={styles.focusGuideLabelWrap}>
                <Text style={styles.focusGuideLabel}>{focusGuide.label}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {annotations.map((annotation) => (
          <View
            key={annotation.id}
            style={[
              styles.annotationWrap,
              {
                left: `${annotation.x * 100}%`,
                top: `${annotation.y * 100}%`,
              },
            ]}
          >
            <View style={[styles.annotationDot, { backgroundColor: annotation.color }]} />
            <View style={styles.annotationCard}>
              <Text style={styles.annotationLabel}>{annotation.label}</Text>
              <Text style={styles.annotationReason}>{annotation.reason}</Text>
              <Text style={styles.annotationConfidence}>
                {Math.round(annotation.confidence * 100)}% confidence
              </Text>
            </View>
          </View>
        ))}
      </View>

      <SafeAreaView style={styles.safeArea}>
        <View style={styles.topBar}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Ved voice mode</Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {isRecording ? 'Listening' : isSpeaking ? 'Speaking' : isBusy ? 'Thinking' : 'Ready'}
            </Text>
          </View>
        </View>

        <View style={styles.sideActions}>
          <Pressable
            onPress={() => setIsPanelOpen((current) => !current)}
            style={styles.panelToggle}
          >
            <Text style={styles.panelToggleText}>{isPanelOpen ? 'Hide panel' : 'Show panel'}</Text>
          </Pressable>
        </View>

        {isPanelOpen ? (
          <View style={styles.bottomPanel}>
            <View style={styles.panelHeader}>
              <View style={styles.panelCopy}>
                <Text style={styles.panelSummary}>{sceneSummary}</Text>
                {pendingFollowUpMode ? (
                  <Text style={styles.followUpText}>
                    Hold the notebook steady. Ved is scanning for readable math.
                  </Text>
                ) : null}
                {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
              </View>
              <Pressable
                onPress={() => setIsPanelOpen(false)}
                style={styles.closeButton}
              >
                <Text style={styles.closeButtonText}>Close</Text>
              </Pressable>
            </View>

            <View style={styles.metaRow}>
              <Text style={styles.metaText}>
                {isRecording
                  ? `Listening ${formatDuration(recordingMillis)}. Stop speaking to send.`
                  : pendingFollowUpMode
                    ? 'Ved is scanning the camera for your notebook and equations.'
                  : isSpeaking
                    ? 'Ved is speaking back.'
                    : isBusy
                      ? 'Ved is processing your request.'
                      : 'Ved is always listening while this app is open.'}
              </Text>
            </View>
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

type RequestVoiceSceneTurnArgs = {
  apiKey: string;
  audioBase64: string;
  audioMimeType: string;
  imageBase64: string;
};

async function requestVoiceSceneTurn({
  apiKey,
  audioBase64,
  audioMimeType,
  imageBase64,
}: RequestVoiceSceneTurnArgs): Promise<VoiceSceneResponse> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${ANALYSIS_MODEL}:generateContent?key=${apiKey}`,
    {
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  'You are Ved, a camera assistant. The user has sent a photo and a short voice question. ' +
                  'Transcribe the spoken question, ignore a leading wake phrase like "Hey Ved" if present, ' +
                  'answer in one or two short spoken sentences, and return only JSON. ' +
                  'Use keys spokenPrompt, answerText, sceneSummary, followUpMode, followUpPrompt, focusX, focusY, focusLabel, cameraZoom, and annotations. ' +
                  'sceneSummary should be one concise sentence. ' +
                  'annotations should be an array of up to 5 objects with label, reason, x, y, confidence, and color. ' +
                  'x and y must be normalized values between 0 and 1. ' +
                  'color must be one of cyan, amber, coral, mint, lime. ' +
                  'When a specific object, line, equation, or region is important, include focusX, focusY, a short focusLabel, and cameraZoom between 0 and 0.7 so the app can emphasize that region. ' +
                  'Keep answerText natural and conversational for spoken playback. ' +
                  'If the user asks to check a notebook, homework, calculation, equation, or math answer and the image does not clearly show readable math, set followUpMode to "show_notebook_math", set followUpPrompt to a short instruction asking them to show the notebook clearly, and keep answerText aligned with that request. ' +
                  'If the math is visible and readable, set followUpMode to "none" and solve or explain it briefly.',
              },
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
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini analysis failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? '')
    .join('');

  if (!text) {
    throw new Error('Gemini did not return a voice-scene response.');
  }

  return parseGeminiJson(text);
}

type RequestVisualFollowUpArgs = {
  apiKey: string;
  imageBase64: string;
  mode: 'show_notebook_math';
};

async function requestVisualFollowUp({
  apiKey,
  imageBase64,
  mode,
}: RequestVisualFollowUpArgs): Promise<VisualFollowUpResponse> {
  const prompt =
    mode === 'show_notebook_math'
      ? 'You are Ved, a camera tutor. Look for a notebook page, handwritten math, printed equations, or calculations. If the math is visible and readable, return JSON with resolved=true, a concise sceneSummary, a short spoken answerText that explains or solves the visible math, focusX, focusY, focusLabel, cameraZoom, and annotations that point to the important lines or equations. If the notebook or math is not yet readable, return resolved=false with a short sceneSummary telling the user to bring the notebook closer, flatter, and steadier. Return only JSON.'
      : 'Return only JSON.';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${ANALYSIS_MODEL}:generateContent?key=${apiKey}`,
    {
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
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
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini visual follow-up failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? '')
    .join('');

  if (!text) {
    throw new Error('Gemini did not return a visual follow-up response.');
  }

  return parseGeminiJson(text) as VisualFollowUpResponse;
}

type SpeakWithGeminiArgs = {
  apiKey: string;
  onDone: () => void;
  onStart: () => void;
  soundRef: React.MutableRefObject<Audio.Sound | null>;
  text: string;
};

async function speakWithGemini({
  apiKey,
  onDone,
  onStart,
  soundRef,
  text,
}: SpeakWithGeminiArgs) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${apiKey}`,
    {
      body: JSON.stringify({
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
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini TTS failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const audioBase64 = payload?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!audioBase64) {
    throw new Error('Gemini did not return audio output.');
  }

  const wavBase64 = pcmToWavBase64(audioBase64, 24000, 1, 16);
  const fileUri = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory}ved-response-${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(fileUri, wavBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  await stopSoundPlayback(soundRef);
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    playThroughEarpieceAndroid: false,
  });

  const { sound } = await Audio.Sound.createAsync(
    { uri: fileUri },
    { shouldPlay: false, progressUpdateIntervalMillis: 200 },
    (status) => {
      if ('didJustFinish' in status && status.didJustFinish) {
        onDone();
        void stopSoundPlayback(soundRef);
      }
    },
  );

  soundRef.current = sound;
  onStart();
  await sound.playAsync();
}

async function stopSoundPlayback(soundRef: React.MutableRefObject<Audio.Sound | null>) {
  if (!soundRef.current) {
    return;
  }

  const sound = soundRef.current;
  soundRef.current = null;
  await sound.unloadAsync().catch(() => undefined);
}

function clearSilenceTimer(
  silenceTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  if (!silenceTimeoutRef.current) {
    return;
  }

  clearTimeout(silenceTimeoutRef.current);
  silenceTimeoutRef.current = null;
}

function clearIntervalIfPresent(
  intervalRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>,
) {
  if (!intervalRef.current) {
    return;
  }

  clearInterval(intervalRef.current);
  intervalRef.current = null;
}

function getAudioMimeType() {
  return Platform.OS === 'ios' ? 'audio/wav' : 'audio/aac';
}

function getRecordingOptions(): Audio.RecordingOptions {
  return Platform.select<Audio.RecordingOptions>({
    android: {
      android: {
        extension: '.aac',
        outputFormat: Audio.AndroidOutputFormat.AAC_ADTS,
        audioEncoder: Audio.AndroidAudioEncoder.AAC,
        sampleRate: 24000,
        numberOfChannels: 1,
        bitRate: 64000,
      },
      ios: {
        extension: '.aac',
        outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
        audioQuality: Audio.IOSAudioQuality.HIGH,
        sampleRate: 24000,
        numberOfChannels: 1,
        bitRate: 64000,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      },
      web: {
        mimeType: 'audio/webm',
        bitsPerSecond: 64000,
      },
      isMeteringEnabled: true,
    },
    ios: {
      android: {
        extension: '.aac',
        outputFormat: Audio.AndroidOutputFormat.AAC_ADTS,
        audioEncoder: Audio.AndroidAudioEncoder.AAC,
        sampleRate: 24000,
        numberOfChannels: 1,
        bitRate: 64000,
      },
      ios: {
        extension: '.wav',
        outputFormat: Audio.IOSOutputFormat.LINEARPCM,
        audioQuality: Audio.IOSAudioQuality.HIGH,
        sampleRate: 24000,
        numberOfChannels: 1,
        bitRate: 768000,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      },
      web: {
        mimeType: 'audio/webm',
        bitsPerSecond: 64000,
      },
      isMeteringEnabled: true,
    },
    default: Audio.RecordingOptionsPresets.HIGH_QUALITY,
  }) as Audio.RecordingOptions;
}

function pcmToWavBase64(
  pcmBase64: string,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
) {
  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
  const wavHeader = createWavHeader(
    pcmBuffer.length,
    sampleRate,
    channels,
    bitsPerSample,
  );

  return Buffer.concat([wavHeader, pcmBuffer]).toString('base64');
}

function createWavHeader(
  dataLength: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

function parseGeminiJson(text: string): VoiceSceneResponse {
  try {
    return JSON.parse(text) as VoiceSceneResponse;
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Gemini response was not valid JSON.');
    }

    return JSON.parse(jsonMatch[0]) as VoiceSceneResponse;
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sanitizeLabel(value: unknown, index: number) {
  if (typeof value !== 'string' || !value.trim()) {
    return `Object ${index + 1}`;
  }

  return value.trim().slice(0, 42);
}

function stripWakePhrase(text: string) {
  return text.replace(/^hey\s+ved[\s,.:;-]*/i, '').trim() || text;
}

function formatDuration(durationMillis: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');

  return `${minutes}:${seconds}`;
}

type CenteredStateProps = {
  actionLabel: string;
  description: string;
  onPress: () => void;
  title: string;
};

function CenteredState({ actionLabel, description, onPress, title }: CenteredStateProps) {
  return (
    <View style={styles.centeredState}>
      <StatusBar style="light" />
      <Text style={styles.centeredTitle}>{title}</Text>
      <Text style={styles.centeredDescription}>{description}</Text>
      <Pressable onPress={onPress} style={styles.permissionButton}>
        <Text style={styles.permissionButtonText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  activeVoiceButton: {
    backgroundColor: '#5CFFF2',
  },
  annotationCard: {
    backgroundColor: 'rgba(12, 16, 27, 0.56)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 8,
    maxWidth: 184,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  annotationConfidence: {
    color: '#89A3C8',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 6,
  },
  annotationDot: {
    borderColor: 'rgba(255, 255, 255, 0.65)',
    borderRadius: 9,
    borderWidth: 2,
    height: 18,
    width: 18,
  },
  annotationLabel: {
    color: '#F7FAFF',
    fontSize: 14,
    fontWeight: '700',
  },
  annotationLayer: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  focusGuide: {
    marginLeft: -34,
    marginTop: -34,
    position: 'absolute',
  },
  focusGuideLabel: {
    color: '#F4FAFF',
    fontSize: 11,
    fontWeight: '700',
  },
  focusGuideLabelWrap: {
    alignSelf: 'center',
    backgroundColor: 'rgba(10, 18, 30, 0.52)',
    borderRadius: 999,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  focusGuideRing: {
    borderColor: 'rgba(124, 231, 255, 0.95)',
    borderRadius: 34,
    borderWidth: 3,
    height: 68,
    width: 68,
  },
  annotationReason: {
    color: '#D5E1F2',
    fontSize: 12,
    lineHeight: 16,
    marginTop: 4,
  },
  annotationWrap: {
    marginLeft: -12,
    marginTop: -12,
    position: 'absolute',
  },
  appShell: {
    backgroundColor: '#08111D',
    flex: 1,
  },
  badge: {
    backgroundColor: 'rgba(7, 13, 22, 0.58)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  badgeText: {
    color: '#F3F7FF',
    fontSize: 12,
    fontWeight: '700',
  },
  bottomPanel: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(6, 10, 18, 0.56)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 28,
    borderWidth: 1,
    marginHorizontal: 14,
    marginTop: 'auto',
    paddingHorizontal: 16,
    paddingBottom: 18,
    paddingTop: 18,
  },
  centeredDescription: {
    color: '#AFC3DC',
    fontSize: 16,
    lineHeight: 24,
    marginTop: 12,
    maxWidth: 320,
    textAlign: 'center',
  },
  centeredState: {
    alignItems: 'center',
    backgroundColor: '#08111D',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  centeredTitle: {
    color: '#F5F9FF',
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center',
  },
  closeButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  closeButtonText: {
    color: '#EAF3FF',
    fontSize: 12,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.45,
  },
  errorText: {
    color: '#FFB7B3',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 10,
  },
  followUpText: {
    color: '#95DFFF',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
    marginTop: 10,
  },
  metaRow: {
    marginTop: 10,
  },
  metaText: {
    color: '#8AA0BC',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  panelHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  panelCopy: {
    flex: 1,
  },
  panelSummary: {
    color: '#D8E3F3',
    fontSize: 13,
    lineHeight: 18,
    maxWidth: 260,
  },
  panelToggle: {
    backgroundColor: 'rgba(6, 10, 18, 0.72)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  panelToggleText: {
    color: '#E7F3FF',
    fontSize: 12,
    fontWeight: '700',
  },
  permissionButton: {
    alignItems: 'center',
    backgroundColor: '#7CE7FF',
    borderRadius: 18,
    justifyContent: 'center',
    marginTop: 18,
    minHeight: 54,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  permissionButtonText: {
    color: '#08202A',
    fontSize: 15,
    fontWeight: '800',
  },
  safeArea: {
    flex: 1,
    paddingBottom: 14,
  },
  sideActions: {
    alignItems: 'flex-end',
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  voiceButton: {
    alignItems: 'center',
    borderRadius: 18,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});
