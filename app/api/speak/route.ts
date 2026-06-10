import { NextResponse } from 'next/server';

import { synthesizeSpeech } from '../../../lib/gemini';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      text?: string;
    };

    if (!body.text?.trim()) {
      return NextResponse.json({ error: 'Missing text payload.' }, { status: 400 });
    }

    const audioBase64 = await synthesizeSpeech(body.text);

    if (!audioBase64) {
      return NextResponse.json({ error: 'No audio returned.' }, { status: 502 });
    }

    return NextResponse.json({ audioBase64 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Speech generation failed.',
      },
      { status: 500 },
    );
  }
}
