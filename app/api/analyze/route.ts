import { NextResponse } from 'next/server';

import { analyzeFrame } from '../../../lib/gemini';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      imageBase64?: string;
      question?: string;
    };

    if (!body.question) {
      return NextResponse.json(
        { error: 'Missing question payload.' },
        { status: 400 },
      );
    }

    const result = await analyzeFrame(body.question, body.imageBase64);

    return NextResponse.json({ result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Frame analysis failed.',
      },
      { status: 500 },
    );
  }
}
