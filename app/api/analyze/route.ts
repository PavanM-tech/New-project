import { NextResponse } from 'next/server';

import { analyzeFrame, type ConversationTurn } from '../../../lib/gemini';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      history?: ConversationTurn[];
      imageBase64?: string;
      question?: string;
    };

    if (!body.question) {
      return NextResponse.json(
        { error: 'Missing question payload.' },
        { status: 400 },
      );
    }

    const result = await analyzeFrame(body.question, body.imageBase64, body.history ?? []);

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
