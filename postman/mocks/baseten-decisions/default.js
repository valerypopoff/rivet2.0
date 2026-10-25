// Repo-owned contract subset, not a live model. Official System One reference, 2026-10-26.
const { createServer } = require('node:http');
let rateLimits = 0;
createServer(async (req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' });
    res.end(JSON.stringify(value));
  };
  const fail = (status, message) => send(status, { error: message, error_type: 'Validation' });
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'POST' || url.pathname !== '/v1/systemone') return fail(501, 'Unmodeled endpoint');
  if (req.headers.authorization !== 'Bearer fixture-key') return fail(401, 'Invalid API key');
  const scenario = url.searchParams.get('fixture');
  if (scenario === 'unauthorized') return fail(401, 'Invalid API key');
  if (scenario === 'rate-limit') {
    if (rateLimits++ < 2) return fail(429, 'Capacity limited');
    rateLimits = 0; // The sequential client can verify another complete retry cycle.
  }
  if (scenario === 'json-error') return fail(503, 'Unavailable');
  if (scenario === 'html-error') {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>Unavailable</html>');
    return;
  }
  if (scenario === 'hang') return;
  try {
    let body = req.body;
    if (body === undefined) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } else if (typeof body === 'string') body = JSON.parse(body);
    if (
      !['decision-models/baseten-elephant-9b-latest', 'decision-models/baseten-mammoth-27b-latest'].includes(
        body.model,
      ) ||
      body.state === undefined ||
      !body.questions ||
      Object.keys(body).some((key) => !['model', 'state', 'questions'].includes(key))
    )
      return fail(422, 'Invalid request shape');
    const answers = Object.create(null);
    let options = 0;
    for (const [id, question] of Object.entries(body.questions)) {
      if (!['choice', 'score', 'noul'].includes(question.type))
        return fail(422, 'Question type must be choice, noul or score');
      const keys = question.type === 'noul' ? [] : Object.keys(question.criteria ?? {});
      options += question.type === 'noul' ? 2 : keys.length;
      if (question.type !== 'noul' && keys.length < 2) return fail(422, 'Missing criteria');
      answers[id] =
        question.type === 'noul'
          ? { type: 'noul', noul: 0.9 }
          : question.type === 'choice'
            ? {
                type: 'choice',
                choice: keys[0],
                confidence: 1,
                probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])),
              }
            : {
                type: 'score',
                score: 0.5,
                confidence: 0,
                probabilities: Object.fromEntries(keys.map((key) => [key, 1 / keys.length])),
                legend: Object.fromEntries(keys.map((key) => [key, question.criteria[key]])),
              };
    }
    if (!Object.keys(answers).length || options > 512) return fail(422, 'Invalid option count');
    if (body.state?.messages) {
      let images = 0;
      for (const message of body.state.messages) {
        if (!['user', 'assistant'].includes(message.role)) return fail(422, 'Invalid message role');
        if (typeof message.content === 'string') continue;
        if (!Array.isArray(message.content)) return fail(422, 'Invalid content');
        for (const part of message.content) {
          if (part.type === 'text' && typeof part.text === 'string') continue;
          if (
            part.type !== 'image_url' ||
            message.role !== 'user' ||
            !/^data:image\/(png|jpeg|webp);base64,/.test(part.image_url?.url) ||
            ++images > 4 ||
            ![undefined, 'auto'].includes(part.image_url.detail)
          )
            return fail(422, 'Invalid image content');
        }
      }
    }
    send(200, {
      model: 'fixture-backend-model',
      answers: scenario === 'malformed' ? {} : answers,
      usage: { input_tokens: 100, output_tokens: Object.keys(answers).length },
    });
  } catch {
    fail(400, 'Invalid request body');
  }
}).listen(process.env.PORT || 4932);
