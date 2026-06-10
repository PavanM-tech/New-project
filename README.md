# Ved Web Prototype

A Next.js front end for Ved that uses:

- live browser camera preview
- browser speech recognition for faster voice input
- browser speech synthesis for faster voice replies
- Gemini 2.5 Flash only for frame analysis

That cuts the old lag caused by sending audio to Gemini for transcription and then waiting again for Gemini TTS.

## What changed

- The front end is now Next.js instead of the Expo UI.
- Ved only analyzes the current camera frame when you ask a question.
- The prompt is stricter about annotating only the part related to your question.
- The older darker annotation style is restored.
- A notebook popup still appears when Ved returns the correct working for a calculation.
- The logo now animates differently for listening, thinking, and replying.

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Create the env file:

```bash
cp .env.example .env
```

3. Add your Gemini key:

```env
GEMINI_API_KEY=your_actual_key
```

4. Start the Next.js app:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000)

## How Ved works now

- `Ask out loud` uses the browser speech API for low-latency capture.
- Ved grabs one camera frame when you ask the question.
- `/api/analyze` sends only the frame and the cleaned question to Gemini.
- The browser speaks the answer locally, which is much faster than waiting for Gemini TTS.

## Useful prompts

- `What is wrong here?`
- `Check my calculation`
- `Explain this step`
- `Show the correct way`

## Notes

- Voice input works best in Chromium-based browsers on Android and desktop.
- If browser speech recognition is unavailable, you can still use the quick actions or type your question.
- The old Expo files are still in the repo for reference, but the active front end is the Next.js app.
