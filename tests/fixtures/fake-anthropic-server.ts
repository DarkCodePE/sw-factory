// Servidor falso de prueba para la API Messages de Anthropic (v1/messages)
const portArg = process.argv[2];
const port = portArg ? Number(portArg) : 8085;

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/v1/messages') {
      return new Response('Not found', { status: 404 });
    }

    const version = req.headers.get('anthropic-version');
    const apiKey = req.headers.get('x-api-key');
    const auth = req.headers.get('authorization');

    if (!apiKey && !auth) {
      return new Response('Missing credentials', { status: 401 });
    }

    const body = await req.json() as any;
    const promptText = body.messages?.find((m: any) => m.role === 'user')?.content ?? 'sin mensaje';

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (obj: any) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

        send({ type: 'message_start', message: { id: 'msg_fake_1', usage: { input_tokens: 25, output_tokens: 5 } } });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: `[Fake Anthropic ${version}] Respuesta confirmada para modelo ${body.model}: "${typeof promptText === 'string' ? promptText : JSON.stringify(promptText)}"`,
          },
        });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } });
        send({ type: 'message_stop' });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  },
});

console.log(`Fake Anthropic server listening on http://127.0.0.1:${server.port}`);
