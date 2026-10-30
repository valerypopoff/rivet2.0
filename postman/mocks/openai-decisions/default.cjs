// Local Noul/predicate contract only; no proxying or live credentials.
// https://developers.openai.com/api/docs/guides/decisions#include-images-in-question-instructions
const { createServer } = require('node:http');
createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST' || req.url !== '/v1/decisions') return send(501, { error: 'Unmodeled endpoint' });
  try {
    let body = req.body;
    if (body === undefined) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } else if (typeof body === 'string') body = JSON.parse(body);
    if (
      body.model !== 'gpt-6-luna' ||
      body.input === undefined ||
      !Array.isArray(body.questions) ||
      !body.questions.length
    )
      return send(400, { error: 'Invalid Decisions request' });
    if (body.questions.some((q) => q.type !== 'predicate')) return send(501, { error: 'Only predicates modeled' });
    for (const question of body.questions) {
      if (typeof question.instructions === 'string' && question.instructions.trim()) continue;
      if (
        !Array.isArray(question.instructions) ||
        !question.instructions.length ||
        question.instructions.some((part) =>
          part.type === 'input_text'
            ? typeof part.text !== 'string'
            : part.type !== 'input_image' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(part.image_url),
        )
      )
        return send(400, { error: 'Invalid question content parts' });
    }
    send(200, {
      model: body.model,
      answers: body.questions.map((q) => ({ name: q.name, type: 'predicate', probability: 0.8 })),
      usage: {
        input_tokens: 1000,
        output_tokens: 0,
        ...(['cache-accounting', 'cache-invalid', 'cache-partial'].includes(body.input)
          ? {
              input_tokens_details: {
                cached_tokens: body.input === 'cache-invalid' ? 901 : 400,
                ...(body.input === 'cache-partial' ? {} : { cache_write_tokens: 100 }),
              },
            }
          : {}),
      },
    });
  } catch {
    send(400, { error: 'Invalid JSON' });
  }
}).listen(Number(process.env.PORT || 4923), '127.0.0.1');
