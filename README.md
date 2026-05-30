# Astra AR Prototype

An Expo prototype for an Astra-style camera assistant that sends live frames to Gemini 2.5 Flash and renders annotation overlays on top of the preview.

## What this prototype does

- Opens the rear camera in an Expo app
- Captures a frame on demand or on a repeating live-scan interval
- Sends the frame plus your prompt to Gemini 2.5 Flash
- Renders Gemini's response as overlay labels with normalized screen positions

## What it does not do yet

- True world-anchored AR with ARCore or ARKit
- Persistent spatial mapping across camera movement
- Voice conversation or continuous video streaming

This first version is intentionally Expo-friendly so you can test it immediately with your current setup.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a local env file and add your Gemini key:

```bash
cp .env.example .env
```

Add:

```bash
EXPO_PUBLIC_GEMINI_API_KEY=your_actual_key
```

3. Start the Expo app:

```bash
npm start
```

4. Open it in Expo Go on your device.

## How to use it

- Grant camera access
- Point the phone camera at a scene
- Adjust the prompt if you want Gemini to focus on a specific class of objects
- Tap `Analyze frame` for a single inference
- Tap `Start live scan` to refresh the overlay every few seconds

## Next steps for a stronger AR version

- Move from Expo Go to an Expo dev client
- Prebuild native projects
- Add ARCore or ARKit bindings for true 3D anchors
- Replace normalized overlay points with tracked object positions or world anchors
- Add a speech layer for live conversational guidance
