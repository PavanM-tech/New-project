import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Annotation = {
  color: string;
  confidence: number;
  id: string;
  label: string;
  reason: string;
  x: number;
  y: number;
};

type GeminiResponse = {
  annotations?: Array<Partial<Annotation>>;
  sceneSummary?: string;
};

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';
const LIVE_ANALYZE_INTERVAL_MS = 6000;
const MAX_ANNOTATIONS = 5;
const PRESET_PROMPTS = [
  'Find the most important objects in view.',
  'Point out anything that looks like a control, button, or switch.',
  'Highlight things I might want to explain to a user.',
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
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [question, setQuestion] = useState(PRESET_PROMPTS[0]);
  const [sceneSummary, setSceneSummary] = useState(
    'Use the camera, then ask Gemini to mark the most important objects in view.',
  );
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canAnalyze = useMemo(
    () => Boolean(permission?.granted && cameraReady && cameraRef.current && !isAnalyzing),
    [cameraReady, isAnalyzing, permission?.granted],
  );

  const normalizeAnnotations = useCallback((response: GeminiResponse): Annotation[] => {
    const rawAnnotations = Array.isArray(response.annotations) ? response.annotations : [];

    return rawAnnotations.slice(0, MAX_ANNOTATIONS).map((item, index) => {
      const colorKey = typeof item.color === 'string' ? item.color.toLowerCase() : 'cyan';

      return {
        color: COLOR_MAP[colorKey] ?? COLOR_MAP.cyan,
        confidence: clampNumber(item.confidence, 0.25, 0, 1),
        id: `${Date.now()}-${index}`,
        label: sanitizeLabel(item.label, index),
        reason: typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : 'Detected by Gemini.',
        x: clampNumber(item.x, 0.5, 0.05, 0.95),
        y: clampNumber(item.y, 0.5, 0.08, 0.9),
      };
    });
  }, []);

  const analyzeScene = useCallback(async () => {
    if (!API_KEY) {
      Alert.alert(
        'Gemini key missing',
        'Add EXPO_PUBLIC_GEMINI_API_KEY to your environment before running the app.',
      );
      return;
    }

    if (!cameraRef.current || !canAnalyze) {
      return;
    }

    try {
      setIsAnalyzing(true);
      setErrorMessage(null);

      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        imageType: 'jpg',
        quality: 0.35,
        skipProcessing: true,
      });

      if (!photo.base64) {
        throw new Error('Camera capture did not include base64 image data.');
      }

      const geminiResult = await requestSceneAnnotations({
        apiKey: API_KEY,
        imageBase64: photo.base64,
        prompt: question.trim() || PRESET_PROMPTS[0],
      });

      const parsedAnnotations = normalizeAnnotations(geminiResult);
      setAnnotations(parsedAnnotations);
      setSceneSummary(
        geminiResult.sceneSummary?.trim() ||
          'Gemini did not return a scene summary, but the overlay has been updated.',
      );
      setLastAnalyzedAt(new Date().toLocaleTimeString());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The scene could not be analyzed.';
      setErrorMessage(message);
    } finally {
      setIsAnalyzing(false);
    }
  }, [canAnalyze, normalizeAnnotations, question]);

  useEffect(() => {
    if (!liveMode) {
      return;
    }

    const intervalId = setInterval(() => {
      if (!isAnalyzing) {
        void analyzeScene();
      }
    }, LIVE_ANALYZE_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [analyzeScene, isAnalyzing, liveMode]);

  if (!permission) {
    return (
      <CenteredState
        actionLabel="Request Camera Access"
        description="Preparing the camera permission flow..."
        onPress={() => {
          void requestPermission();
        }}
        title="Camera setup"
      />
    );
  }

  if (!permission.granted) {
    return (
      <CenteredState
        actionLabel="Allow Camera"
        description="This prototype needs live camera access to capture frames and send them to Gemini for annotations."
        onPress={() => {
          void requestPermission();
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
            <Text style={styles.badgeText}>Astra-style overlay prototype</Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{liveMode ? 'Live scan on' : 'Live scan off'}</Text>
          </View>
        </View>

        <View style={styles.bottomPanel}>
          <Text style={styles.panelTitle}>Live scene annotations</Text>
          <Text style={styles.panelSummary}>{sceneSummary}</Text>
          {lastAnalyzedAt ? (
            <Text style={styles.metaText}>Last analyzed at {lastAnalyzedAt}</Text>
          ) : null}
          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

          <TextInput
            multiline
            onChangeText={setQuestion}
            placeholder="Tell Gemini what to highlight..."
            placeholderTextColor="#8A9AB0"
            style={styles.promptInput}
            value={question}
          />

          <ScrollView
            contentContainerStyle={styles.presetRow}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {PRESET_PROMPTS.map((preset) => (
              <Pressable key={preset} onPress={() => setQuestion(preset)} style={styles.presetChip}>
                <Text style={styles.presetText}>{preset}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={styles.buttonRow}>
            <ActionButton
              disabled={!canAnalyze}
              label={isAnalyzing ? 'Analyzing...' : 'Analyze frame'}
              onPress={() => {
                void analyzeScene();
              }}
              primary
            />
            <ActionButton
              label={liveMode ? 'Stop live scan' : 'Start live scan'}
              onPress={() => setLiveMode((current) => !current)}
            />
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label="Clear labels"
              onPress={() => {
                setAnnotations([]);
                setSceneSummary('Overlay cleared. Capture another frame when you are ready.');
              }}
            />
          </View>

          <Text style={styles.footerNote}>
            This Expo MVP uses screen-space overlays. For true world-anchored AR labels, the next step is
            a native dev client with ARCore or ARKit.
          </Text>
        </View>
      </SafeAreaView>

      {isAnalyzing ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color="#FFFFFF" size="large" />
          <Text style={styles.loadingText}>Gemini is reading the current frame...</Text>
        </View>
      ) : null}
    </View>
  );
}

type RequestSceneAnnotationsArgs = {
  apiKey: string;
  imageBase64: string;
  prompt: string;
};

async function requestSceneAnnotations({
  apiKey,
  imageBase64,
  prompt,
}: RequestSceneAnnotationsArgs): Promise<GeminiResponse> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  'You are helping drive an augmented-reality annotation overlay on a phone camera preview. ' +
                  'Return only JSON with keys sceneSummary and annotations. ' +
                  'sceneSummary must be a short plain-English sentence. ' +
                  'annotations must be an array with up to 5 items. ' +
                  'Each item must include label, reason, x, y, confidence, and color. ' +
                  'x and y must be normalized values between 0 and 1 representing where a label should be placed on screen. ' +
                  'Choose one of these colors: cyan, amber, coral, mint, lime. ' +
                  `User request: ${prompt}`,
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
          temperature: 0.4,
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
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? '')
    .join('');

  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  return parseGeminiJson(text);
}

function parseGeminiJson(text: string): GeminiResponse {
  try {
    return JSON.parse(text) as GeminiResponse;
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Gemini response was not valid JSON.');
    }

    return JSON.parse(jsonMatch[0]) as GeminiResponse;
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
      <Pressable onPress={onPress} style={[styles.actionButton, styles.primaryButton]}>
        <Text style={styles.primaryButtonText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

type ActionButtonProps = {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  primary?: boolean;
};

function ActionButton({ disabled, label, onPress, primary }: ActionButtonProps) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.actionButton,
        primary ? styles.primaryButton : styles.secondaryButton,
        disabled ? styles.disabledButton : null,
      ]}
    >
      <Text style={primary ? styles.primaryButtonText : styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: 'center',
    borderRadius: 18,
    flex: 1,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  annotationCard: {
    backgroundColor: 'rgba(12, 16, 27, 0.9)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 8,
    maxWidth: 180,
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
    backgroundColor: 'rgba(6, 10, 18, 0.82)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 28,
    borderWidth: 1,
    marginHorizontal: 14,
    marginTop: 'auto',
    paddingHorizontal: 16,
    paddingBottom: 18,
    paddingTop: 18,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
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
  disabledButton: {
    opacity: 0.55,
  },
  errorText: {
    color: '#FFB7B3',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8,
  },
  footerNote: {
    color: '#93A7C3',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 14,
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
  metaText: {
    color: '#8AA0BC',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
  },
  panelSummary: {
    color: '#D8E3F3',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  panelTitle: {
    color: '#F7FBFF',
    fontSize: 22,
    fontWeight: '800',
  },
  presetChip: {
    backgroundColor: 'rgba(117, 156, 255, 0.12)',
    borderColor: 'rgba(117, 156, 255, 0.25)',
    borderRadius: 999,
    borderWidth: 1,
    marginRight: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  presetRow: {
    paddingVertical: 4,
  },
  presetText: {
    color: '#DCE7FA',
    fontSize: 12,
    fontWeight: '700',
  },
  primaryButton: {
    backgroundColor: '#7CE7FF',
  },
  primaryButtonText: {
    color: '#08202A',
    fontSize: 15,
    fontWeight: '800',
  },
  promptInput: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 18,
    borderWidth: 1,
    color: '#F3F8FF',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 14,
    minHeight: 86,
    paddingHorizontal: 14,
    paddingVertical: 14,
    textAlignVertical: 'top',
  },
  safeArea: {
    flex: 1,
    paddingBottom: 14,
  },
  secondaryButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderWidth: 1,
  },
  secondaryButtonText: {
    color: '#F2F7FF',
    fontSize: 15,
    fontWeight: '700',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 10,
  },
});
