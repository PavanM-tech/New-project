import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
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

type VoiceSceneResponse = {
  annotations?: Array<Partial<Annotation>>;
  answerText?: string;
  sceneSummary?: string;
  spokenPrompt?: string;
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
const VOICE_EXAMPLES = [
  'Hey Ved, what is this?',
  'Hey Ved, explain the most important thing in front of me.',
  'Hey Ved, point out any switches or controls you can see.',
];
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
  const hasHeardSpeechRef = useRef(false);
  const isStoppingRef = useRef(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = Audio.usePermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [sceneSummary, setSceneSummary] = useState(
    'Tap once, say "Hey Ved..." and pause when you are done. Ved will auto-send your request and answer in voice.',
  );
  const [heardPrompt, setHeardPrompt] = useState('Try saying: "Hey Ved, what is this?"');
  const [statusLine, setStatusLine] = useState('Ready');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [isExamplesOpen, setIsExamplesOpen] = useState(false);
  const [recordingMillis, setRecordingMillis] = useState(0);

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

  useEffect(() => {
    return () => {
      clearSilenceTimer(silenceTimeoutRef);
      void stopSoundPlayback(soundRef);
      if (recordingRef.current) {
        void recordingRef.current.stopAndUnloadAsync().catch(() => undefined);
      }
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
      const resolvedAnswer =
        voiceResult.answerText?.trim() ||
        voiceResult.sceneSummary?.trim() ||
        'I can see the scene, but I need a clearer question to answer well.';

      setAnnotations(parsedAnnotations);
      setHeardPrompt(
        stripWakePhrase(voiceResult.spokenPrompt?.trim() || 'I heard your question, but not clearly.'),
      );
      setSceneSummary(
        voiceResult.sceneSummary?.trim() ||
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
      setStatusLine('Voice request failed');
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
      setErrorMessage(null);
      setHeardPrompt('Listening for your question...');
      setStatusLine('Listening');
      setRecordingMillis(0);
      setIsPanelOpen(true);
      setIsExamplesOpen(false);
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
    }
  }, [canStartListening, micPermission, requestMicPermission]);

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

  return (
    <View style={styles.appShell}>
      <StatusBar style="light" />
      <CameraView
        ref={cameraRef}
        animateShutter={false}
        facing="back"
        onCameraReady={() => setCameraReady(true)}
        style={StyleSheet.absoluteFill}
      />

      <View pointerEvents="none" style={styles.annotationLayer}>
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
              <View>
                <Text style={styles.panelTitle}>Ask Ved out loud</Text>
                <Text style={styles.panelSummary}>{sceneSummary}</Text>
              </View>
              <Pressable
                onPress={() => setIsPanelOpen(false)}
                style={styles.closeButton}
              >
                <Text style={styles.closeButtonText}>Close</Text>
              </Pressable>
            </View>

            <View style={styles.statusCard}>
              <Text style={styles.statusLabel}>Heard</Text>
              <Text style={styles.statusValue}>{heardPrompt}</Text>
              <Text style={styles.statusMeta}>{statusLine}</Text>
              {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
            </View>

            <View style={styles.controlsRow}>
              <Pressable
                disabled={!canStartListening}
                onPress={() => {
                  void startVoiceCapture();
                }}
                style={[
                  styles.voiceButton,
                  styles.primaryVoiceButton,
                  !canStartListening ? styles.disabledButton : null,
                  isRecording ? styles.activeVoiceButton : null,
                ]}
              >
                <Text style={styles.primaryVoiceButtonText}>
                  {isRecording ? 'Listening for silence...' : 'Talk to Ved'}
                </Text>
              </Pressable>
            </View>

            <View style={styles.metaRow}>
              <Text style={styles.metaText}>
                {isRecording
                  ? `Recording ${formatDuration(recordingMillis)}. Stop speaking to send.`
                  : 'Ved replies in Gemini voice only.'}
              </Text>
              <Pressable
                onPress={() => setIsExamplesOpen((current) => !current)}
                style={styles.examplesToggle}
              >
                <Text style={styles.examplesToggleText}>
                  {isExamplesOpen ? 'Hide examples' : 'Show examples'}
                </Text>
              </Pressable>
            </View>

            {isExamplesOpen ? (
              <View style={styles.examplesPanel}>
                {VOICE_EXAMPLES.map((example) => (
                  <Text key={example} style={styles.exampleLine}>
                    {example}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </SafeAreaView>

      {isBusy ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color="#FFFFFF" size="large" />
          <Text style={styles.loadingText}>
            {isSpeaking ? 'Ved is talking back...' : 'Ved is looking and listening...'}
          </Text>
        </View>
      ) : null}
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
                  'Use keys spokenPrompt, answerText, sceneSummary, and annotations. ' +
                  'sceneSummary should be one concise sentence. ' +
                  'annotations should be an array of up to 5 objects with label, reason, x, y, confidence, and color. ' +
                  'x and y must be normalized values between 0 and 1. ' +
                  'color must be one of cyan, amber, coral, mint, lime. ' +
                  'Keep answerText natural and conversational for spoken playback.',
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
      <Pressable onPress={onPress} style={[styles.voiceButton, styles.primaryVoiceButton]}>
        <Text style={styles.primaryVoiceButtonText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  activeVoiceButton: {
    backgroundColor: '#5CFFF2',
  },
  annotationCard: {
    backgroundColor: 'rgba(12, 16, 27, 0.9)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
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
    backgroundColor: 'rgba(6, 10, 18, 0.78)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
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
  controlsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
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
  exampleLine: {
    color: '#DCE8F8',
    fontSize: 13,
    lineHeight: 19,
  },
  examplesPanel: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 18,
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  examplesToggle: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  examplesToggleText: {
    color: '#8EDCFF',
    fontSize: 12,
    fontWeight: '700',
  },
  loadingOverlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(3, 7, 12, 0.45)',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  loadingText: {
    color: '#F8FBFF',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 12,
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  metaText: {
    color: '#8AA0BC',
    fontSize: 12,
    fontWeight: '600',
  },
  panelHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  panelSummary: {
    color: '#D8E3F3',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
    maxWidth: 260,
  },
  panelTitle: {
    color: '#F7FBFF',
    fontSize: 22,
    fontWeight: '800',
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
  primaryVoiceButton: {
    backgroundColor: '#7CE7FF',
  },
  primaryVoiceButtonText: {
    color: '#08202A',
    fontSize: 15,
    fontWeight: '800',
  },
  safeArea: {
    flex: 1,
    paddingBottom: 14,
  },
  secondaryVoiceButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderWidth: 1,
  },
  secondaryVoiceButtonText: {
    color: '#F2F7FF',
    fontSize: 15,
    fontWeight: '700',
  },
  sideActions: {
    alignItems: 'flex-end',
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  statusCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 20,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  statusLabel: {
    color: '#89A5C7',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  statusMeta: {
    color: '#8EDCFF',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 8,
  },
  statusValue: {
    color: '#F4F8FF',
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 22,
    marginTop: 8,
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
    flex: 1,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});
