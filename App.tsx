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
  lineHeight?: number;
  lineWidth?: number;
  placement?: 'left' | 'right' | 'top' | 'bottom';
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
  notebook?: Partial<NotebookOverlayContent> | null;
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
  notebook?: Partial<NotebookOverlayContent> | null;
  resolved?: boolean;
  sceneSummary?: string;
};

type NotebookOverlayContent = {
  answerLine?: string;
  intro?: string;
  steps: string[];
  title: string;
};

type ApiTurnResponse<T> = {
  result: T;
  ttsAudioBase64?: string;
};

const MAX_ANNOTATIONS = 3;
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

const API_BASE_URL =
  Platform.OS === 'web' ? '' : process.env.EXPO_PUBLIC_API_BASE_URL?.trim() ?? '';
const CLIENT_GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY?.trim() ?? '';
const ANALYSIS_MODEL = 'gemini-2.5-flash';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = 'Kore';
const HANDWRITING_FONT_FAMILY = Platform.select({
  android: 'sans-serif-medium',
  ios: 'Noteworthy',
  web: 'cursive',
  default: undefined,
});
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
    'Say "Hey Ved..." and ask your question.',
  );
  const [pendingSceneSummary, setPendingSceneSummary] = useState<string | null>(null);
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
  const [notebookOverlay, setNotebookOverlay] = useState<NotebookOverlayContent | null>(null);
  const [isPreparingSpeech, setIsPreparingSpeech] = useState(false);

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
        lineHeight: clampNumber(
          'lineHeight' in item ? item.lineHeight : undefined,
          44,
          18,
          120,
        ),
        lineWidth: clampNumber(
          'lineWidth' in item ? item.lineWidth : undefined,
          80,
          36,
          160,
        ),
        placement: normalizePlacement('placement' in item ? item.placement : undefined),
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
          quality: 0.26,
          skipProcessing: true,
        }),
      ]);

      if (!photo.base64) {
        throw new Error('Camera capture did not include base64 image data.');
      }

      const voiceTurn = await requestVoiceSceneTurn({
        audioBase64,
        audioMimeType: getAudioMimeType(),
        imageBase64: photo.base64,
      });
      const voiceResult = voiceTurn.result;

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
      const resolvedSceneSummary =
        (followUpMode
          ? voiceResult.followUpPrompt?.trim()
          : voiceResult.sceneSummary?.trim()) ||
        'Updated the markers and answered out loud.';

      setAnnotations(parsedAnnotations);
      setPendingFollowUpMode(followUpMode);
      setFollowUpPrompt(
        followUpMode
          ? voiceResult.followUpPrompt?.trim() || 'Show me your notebook clearly so I can read the math.'
          : null,
      );
      setFocusGuide(focus);
      setCameraZoom(focus?.zoom ?? 0);
      setNotebookOverlay(normalizeNotebookOverlay(voiceResult.notebook));
      setPendingSceneSummary(resolvedSceneSummary);
      setSceneSummary(
        followUpMode
          ? 'Ved is getting the next step ready...'
          : voiceTurn.ttsAudioBase64
            ? 'Ved is about to reply.'
            : 'Ved is preparing the voice reply.'
      );
      setStatusLine(voiceTurn.ttsAudioBase64 ? 'Speaking' : 'Preparing voice');
      setIsPreparingSpeech(!voiceTurn.ttsAudioBase64);

      await playSpeech({
        audioBase64: voiceTurn.ttsAudioBase64,
        soundRef,
        text: resolvedAnswer,
        onStart: () => {
          setIsSpeaking(true);
          setSceneSummary(resolvedSceneSummary);
          setPendingSceneSummary(null);
        },
        onDone: () => {
          setIsSpeaking(false);
          setIsPreparingSpeech(false);
          setStatusLine('Ready');
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ved could not answer that voice request.';
      setErrorMessage(message);
      setStatusLine('Listening will resume');
      setIsSpeaking(false);
      setIsPreparingSpeech(false);
      setPendingSceneSummary(null);
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
    if (!isBackendConfigured()) {
      Alert.alert(
        'Backend not configured',
        'For web deployments, host the app with the bundled Vercel API routes. For native builds, set EXPO_PUBLIC_API_BASE_URL to your deployed backend URL.',
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
        quality: 0.3,
        skipProcessing: true,
      });

      if (!photo.base64) {
        throw new Error('Camera capture did not include base64 image data.');
      }

      const followUpResult = await requestVisualFollowUp({
        imageBase64: photo.base64,
        mode: pendingFollowUpMode,
      });
      const followUpTurn = followUpResult;
      const followUpPayload = followUpTurn.result;

      if (!followUpPayload.resolved) {
        setFocusGuide(null);
        setCameraZoom(0);
        setSceneSummary(
          followUpPrompt ||
            followUpPayload.sceneSummary?.trim() ||
            'Bring the notebook closer and keep it steady.',
        );
        return;
      }

      setAnnotations(normalizeAnnotations(followUpPayload));
      const followUpFocus = normalizeFocusGuide(followUpPayload);
      setPendingFollowUpMode(null);
      setFollowUpPrompt(null);
      setFocusGuide(followUpFocus);
      setCameraZoom(followUpFocus?.zoom ?? 0.12);
      setNotebookOverlay(normalizeNotebookOverlay(followUpPayload.notebook));
      const resolvedFollowUpSummary =
        followUpPayload.sceneSummary?.trim() ||
        'Found the notebook and is explaining the math now.';
      setPendingSceneSummary(resolvedFollowUpSummary);
      setSceneSummary(
        followUpTurn.ttsAudioBase64
          ? 'Ved found it and is about to reply.'
          : 'Ved is preparing the voice reply.'
      );
      setStatusLine(followUpTurn.ttsAudioBase64 ? 'Speaking' : 'Preparing voice');
      setIsPreparingSpeech(!followUpTurn.ttsAudioBase64);

      await playSpeech({
        audioBase64: followUpTurn.ttsAudioBase64,
        soundRef,
        text:
          followUpPayload.answerText?.trim() ||
          'I can see the notebook now, but I need a clearer frame to explain the math well.',
        onStart: () => {
          setIsSpeaking(true);
          setSceneSummary(resolvedFollowUpSummary);
          setPendingSceneSummary(null);
        },
        onDone: () => {
          setIsSpeaking(false);
          setIsPreparingSpeech(false);
          setStatusLine('Ready');
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ved could not scan the notebook yet.';
      setErrorMessage(message);
      setStatusLine('Waiting for a clearer notebook view');
      setIsPreparingSpeech(false);
      setPendingSceneSummary(null);
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
              getAnnotationWrapStyle(annotation.placement),
              {
                left: `${annotation.x * 100}%`,
                top: `${annotation.y * 100}%`,
              },
            ]}
          >
            <View style={[styles.annotationAnchor, getAnnotationAnchorStyle(annotation.placement)]}>
              <View style={[styles.annotationDot, { backgroundColor: annotation.color }]} />
              <View
                style={[
                  styles.annotationLine,
                  getAnnotationLineStyle(annotation.placement, annotation.lineWidth, annotation.lineHeight),
                  { borderColor: `${annotation.color}88` },
                ]}
              />
            </View>
            <View style={[styles.annotationCard, getAnnotationCardStyle(annotation.placement)]}>
              <Text style={styles.annotationLabel}>{annotation.label}</Text>
              <Text style={styles.annotationReason}>{annotation.reason}</Text>
            </View>
          </View>
        ))}
      </View>

      <SafeAreaView style={styles.safeArea}>
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
                  ? `Listening ${formatDuration(recordingMillis)}.`
                  : pendingFollowUpMode
                      ? 'Ved is scanning the notebook view.'
                  : isPreparingSpeech
                    ? 'Ved is shaping the voice reply.'
                  : isSpeaking
                    ? 'Ved is speaking back.'
                    : isBusy
                      ? 'Ved is thinking.'
                      : 'Ved is listening.'}
              </Text>
            </View>
          </View>
        ) : null}

        {!isPanelOpen ? (
          <Pressable
            onPress={() => setIsPanelOpen(true)}
            style={styles.panelDock}
          >
            <Text style={styles.panelDockText}>Ved</Text>
          </Pressable>
        ) : null}

        {notebookOverlay ? (
          <View style={styles.notebookBackdrop}>
            <View style={styles.notebookCard}>
              <View style={styles.notebookHeader}>
                <Text style={styles.notebookTitle}>{notebookOverlay.title}</Text>
                <Pressable
                  onPress={() => setNotebookOverlay(null)}
                  style={styles.notebookCloseButton}
                >
                  <Text style={styles.notebookCloseText}>Close</Text>
                </Pressable>
              </View>
              <View style={styles.notebookPaper}>
                {Array.from({ length: 7 }).map((_, index) => (
                  <View key={index} style={[styles.notebookRule, { top: 66 + index * 42 }]} />
                ))}
                <View style={styles.notebookMargin} />
                {notebookOverlay.intro ? (
                  <Text style={[styles.notebookIntro, styles.handwrittenText]}>
                    {notebookOverlay.intro}
                  </Text>
                ) : null}
                <View style={styles.notebookSteps}>
                  {notebookOverlay.steps.map((step, index) => (
                    <Text
                      key={`${step}-${index}`}
                      style={[
                        styles.notebookStep,
                        styles.handwrittenText,
                        { transform: [{ rotate: `${index % 2 === 0 ? -1.4 : 1.1}deg` }] },
                      ]}
                    >
                      {step}
                    </Text>
                  ))}
                </View>
                {notebookOverlay.answerLine ? (
                  <Text style={[styles.notebookAnswer, styles.handwrittenText]}>
                    {notebookOverlay.answerLine}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

type RequestVoiceSceneTurnArgs = {
  audioBase64: string;
  audioMimeType: string;
  imageBase64: string;
};

async function requestVoiceSceneTurn({
  audioBase64,
  audioMimeType,
  imageBase64,
}: RequestVoiceSceneTurnArgs): Promise<ApiTurnResponse<VoiceSceneResponse>> {
  if (!getApiBaseUrl()) {
    const payload = await callGeminiDirect(ANALYSIS_MODEL, {
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

    const result = parseGeminiJson(extractCandidateText(payload)) as VoiceSceneResponse;
    return {
      result,
      ttsAudioBase64: await synthesizeSpeechDirect(result.answerText),
    };
  }

  const response = await fetch(`${getApiBaseUrl()}/api/voice-scene`, {
    body: JSON.stringify({
      audioBase64,
      audioMimeType,
      imageBase64,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini analysis failed: ${response.status} ${errorText}`);
  }

  return (await response.json()) as ApiTurnResponse<VoiceSceneResponse>;
}

type RequestVisualFollowUpArgs = {
  imageBase64: string;
  mode: 'show_notebook_math';
};

async function requestVisualFollowUp({
  imageBase64,
  mode,
}: RequestVisualFollowUpArgs): Promise<ApiTurnResponse<VisualFollowUpResponse>> {
  if (!getApiBaseUrl()) {
    const prompt = mode === 'show_notebook_math' ? NOTEBOOK_FOLLOW_UP_PROMPT : 'Return only JSON.';
    const payload = await callGeminiDirect(ANALYSIS_MODEL, {
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
    });

    const result = parseGeminiJson(extractCandidateText(payload)) as VisualFollowUpResponse;
    return {
      result,
      ttsAudioBase64: result.resolved ? await synthesizeSpeechDirect(result.answerText) : undefined,
    };
  }

  const response = await fetch(`${getApiBaseUrl()}/api/visual-follow-up`, {
    body: JSON.stringify({
      imageBase64,
      mode,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini visual follow-up failed: ${response.status} ${errorText}`);
  }

  return (await response.json()) as ApiTurnResponse<VisualFollowUpResponse>;
}

type PlaySpeechArgs = {
  audioBase64?: string;
  onDone: () => void;
  onStart: () => void;
  soundRef: React.MutableRefObject<Audio.Sound | null>;
  text: string;
};

async function playSpeech({
  audioBase64,
  onDone,
  onStart,
  soundRef,
  text,
}: PlaySpeechArgs) {
  let resolvedAudioBase64 = audioBase64;

  if (!resolvedAudioBase64) {
    if (!getApiBaseUrl()) {
      resolvedAudioBase64 = await synthesizeSpeechDirect(text);
    } else {
      const response = await fetch(`${getApiBaseUrl()}/api/tts`, {
        body: JSON.stringify({
          text,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini TTS failed: ${response.status} ${errorText}`);
      }

      const payload = await response.json();
      resolvedAudioBase64 = payload?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    }
  }

  if (!resolvedAudioBase64) {
    throw new Error('Gemini did not return audio output.');
  }

  const wavBase64 = pcmToWavBase64(resolvedAudioBase64, 24000, 1, 16);
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

function getApiBaseUrl() {
  return API_BASE_URL;
}

function isBackendConfigured() {
  return Platform.OS === 'web' || Boolean(API_BASE_URL) || Boolean(CLIENT_GEMINI_API_KEY);
}

async function callGeminiDirect(model: string, payload: Record<string, unknown>) {
  if (!CLIENT_GEMINI_API_KEY) {
    throw new Error('Missing EXPO_PUBLIC_GEMINI_API_KEY for native fallback mode.');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CLIENT_GEMINI_API_KEY}`,
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

function extractCandidateText(payload: Record<string, any>) {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? '')
    .join('');

  if (!text) {
    throw new Error('Gemini did not return a valid text candidate.');
  }

  return text;
}

async function synthesizeSpeechDirect(text?: string) {
  if (!text) {
    return undefined;
  }

  const conciseText = makeSpeechConcise(text);
  const payload = await callGeminiDirect(TTS_MODEL, {
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

function normalizeNotebookOverlay(
  notebook: Partial<NotebookOverlayContent> | null | undefined,
): NotebookOverlayContent | null {
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
  };
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

function makeSpeechConcise(text: string) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  const firstSentence = normalized.match(/[^.!?]+[.!?]?/)?.[0]?.trim() ?? normalized;

  if (firstSentence.length <= 120) {
    return firstSentence;
  }

  return `${firstSentence.slice(0, 117).trim()}...`;
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

function normalizePlacement(value: unknown): Annotation['placement'] {
  if (value === 'left' || value === 'right' || value === 'top' || value === 'bottom') {
    return value;
  }

  return 'right';
}

function getAnnotationWrapStyle(placement: Annotation['placement']) {
  switch (placement) {
    case 'left':
      return { marginLeft: -220, marginTop: -18 };
    case 'top':
      return { marginLeft: -96, marginTop: -144 };
    case 'bottom':
      return { marginLeft: -96, marginTop: 18 };
    case 'right':
    default:
      return { marginLeft: 14, marginTop: -18 };
  }
}

function getAnnotationAnchorStyle(placement: Annotation['placement']) {
  if (placement === 'top' || placement === 'bottom') {
    return {
      alignItems: 'center' as const,
      flexDirection: 'column' as const,
    };
  }

  return {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
  };
}

function getAnnotationLineStyle(
  placement: Annotation['placement'],
  lineWidth = 80,
  lineHeight = 44,
) {
  switch (placement) {
    case 'left':
      return {
        borderStyle: 'dashed' as const,
        borderTopWidth: 2,
        marginLeft: 0,
        marginRight: 8,
        transform: [{ rotate: '-4deg' }],
        width: lineWidth,
      };
    case 'top':
      return {
        borderStyle: 'dashed' as const,
        borderLeftWidth: 2,
        height: lineHeight,
        marginBottom: 8,
        transform: [{ rotate: '-3deg' }],
      };
    case 'bottom':
      return {
        borderStyle: 'dashed' as const,
        borderLeftWidth: 2,
        height: lineHeight,
        marginTop: 8,
        transform: [{ rotate: '3deg' }],
      };
    case 'right':
    default:
      return {
        borderStyle: 'dashed' as const,
        borderTopWidth: 2,
        marginLeft: 8,
        transform: [{ rotate: '4deg' }],
        width: lineWidth,
      };
  }
}

function getAnnotationCardStyle(placement: Annotation['placement']) {
  switch (placement) {
    case 'left':
      return { alignSelf: 'flex-end' as const, marginRight: 28, marginTop: -12 };
    case 'top':
      return { alignSelf: 'center' as const, marginBottom: 8 };
    case 'bottom':
      return { alignSelf: 'center' as const, marginTop: 8 };
    case 'right':
    default:
      return { marginLeft: 24, marginTop: -12 };
  }
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
  annotationAnchor: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  annotationCard: {
    backgroundColor: 'rgba(251, 247, 232, 0.96)',
    borderColor: 'rgba(115, 147, 196, 0.34)',
    borderRadius: 18,
    borderWidth: 1,
    maxWidth: 210,
    paddingHorizontal: 14,
    paddingVertical: 10,
    transform: [{ rotate: '-1.5deg' }],
  },
  annotationDot: {
    borderColor: 'rgba(251, 247, 232, 0.88)',
    borderRadius: 9,
    borderWidth: 2,
    height: 18,
    width: 18,
  },
  annotationLabel: {
    color: '#244A82',
    fontFamily: HANDWRITING_FONT_FAMILY,
    fontSize: 16,
    fontStyle: 'italic',
    fontWeight: '700',
  },
  annotationLine: {
    opacity: 0.62,
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
    color: '#22497A',
    fontFamily: HANDWRITING_FONT_FAMILY,
    fontSize: 13,
    fontStyle: 'italic',
    fontWeight: '700',
  },
  focusGuideLabelWrap: {
    alignSelf: 'center',
    backgroundColor: 'rgba(249, 244, 227, 0.92)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(111, 140, 180, 0.35)',
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    transform: [{ rotate: '-2deg' }],
  },
  focusGuideRing: {
    borderColor: 'rgba(124, 231, 255, 0.95)',
    borderRadius: 34,
    borderWidth: 3,
    height: 68,
    width: 68,
  },
  annotationReason: {
    color: '#47617D',
    fontFamily: HANDWRITING_FONT_FAMILY,
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 17,
    marginTop: 4,
  },
  annotationWrap: {
    position: 'absolute',
  },
  appShell: {
    backgroundColor: '#08111D',
    flex: 1,
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
  panelDock: {
    alignSelf: 'center',
    backgroundColor: 'rgba(6, 10, 18, 0.42)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 'auto',
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  panelDockText: {
    color: '#E7F3FF',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
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
  handwrittenText: {
    color: '#214B88',
    fontFamily: HANDWRITING_FONT_FAMILY,
    fontStyle: 'italic',
  },
  notebookAnswer: {
    color: '#173E76',
    fontFamily: HANDWRITING_FONT_FAMILY,
    fontSize: 18,
    fontStyle: 'italic',
    fontWeight: '700',
    marginTop: 14,
    transform: [{ rotate: '-0.8deg' }],
  },
  notebookBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(2, 8, 15, 0.32)',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    paddingHorizontal: 18,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  notebookCard: {
    backgroundColor: '#FFFDF6',
    borderColor: 'rgba(83, 114, 163, 0.22)',
    borderRadius: 26,
    borderWidth: 1,
    maxWidth: 420,
    padding: 14,
    shadowColor: '#04101D',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.24,
    shadowRadius: 28,
    width: '100%',
  },
  notebookCloseButton: {
    backgroundColor: 'rgba(24, 61, 121, 0.08)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  notebookCloseText: {
    color: '#284A7C',
    fontSize: 12,
    fontWeight: '700',
  },
  notebookHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  notebookIntro: {
    fontSize: 17,
    lineHeight: 24,
    marginBottom: 12,
    transform: [{ rotate: '-1deg' }],
  },
  notebookMargin: {
    backgroundColor: 'rgba(226, 114, 114, 0.3)',
    bottom: 16,
    left: 28,
    position: 'absolute',
    top: 16,
    width: 2,
  },
  notebookPaper: {
    backgroundColor: '#FFFDF6',
    borderRadius: 18,
    minHeight: 320,
    overflow: 'hidden',
    paddingBottom: 18,
    paddingHorizontal: 46,
    paddingTop: 24,
    position: 'relative',
  },
  notebookRule: {
    backgroundColor: 'rgba(101, 146, 214, 0.16)',
    height: 1,
    left: 16,
    position: 'absolute',
    right: 16,
  },
  notebookStep: {
    fontSize: 18,
    lineHeight: 26,
    marginBottom: 10,
  },
  notebookSteps: {
    marginTop: 4,
  },
  notebookTitle: {
    color: '#1E4277',
    fontFamily: HANDWRITING_FONT_FAMILY,
    fontSize: 22,
    fontStyle: 'italic',
    fontWeight: '700',
    transform: [{ rotate: '-1.2deg' }],
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
