// Local contract subset from https://docs.liquid.ai/lfm/models/d1, 2026-10-26.
const { createServer } = require('node:http');
createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST' || req.url !== '/decisions/v1/systemone') return send(501, { error: 'Unmodeled endpoint' });
  if (req.headers.authorization !== 'Bearer fixture-key') return send(401, { error: 'Invalid API key' });
  try {
    let body = req.body;
    if (body === undefined) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } else if (typeof body === 'string') body = JSON.parse(body);
    if (
      !['d1', 'd1.1'].includes(body.model) ||
      body.state === undefined ||
      !body.questions ||
      Object.keys(body).some((key) => !['model', 'state', 'questions', 'images'].includes(key))
    )
      return send(422, { error: 'Invalid request shape' });
    if (
      body.images !== undefined &&
      (!Array.isArray(body.images) ||
        body.images.length > 8 ||
        body.images.some(
          (image) => typeof image !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(image),
        ))
    )
      return send(422, { error: 'Invalid shared images' });
    const answers = Object.create(null);
    for (const [id, question] of Object.entries(body.questions)) {
      const keys = Object.keys(question.criteria ?? {});
      if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
      else if (question.type === 'choice' && keys.length >= 2)
        answers[id] = {
          type: 'choice',
          choice: keys[0],
          confidence: 1,
          probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])),
        };
      else if (question.type === 'score' && Array.isArray(question.criteria) && keys.length === 2)
        answers[id] = {
          type: 'score',
          score: 0.5,
          confidence: 0,
          probabilities: { 0: 0.5, 1: 0.5 },
          legend: { 0: question.criteria[0], 1: question.criteria[1] },
        };
      else return send(422, { error: 'Question outside this contract subset' });
    }
    if (!Object.keys(answers).length) return send(422, { error: 'Questions required' });
    send(200, { model: body.model, answers, usage: { input_tokens: 1000, output_tokens: 0 } });
  } catch {
    send(400, { error: 'Invalid request body' });
  }
}).listen(process.env.PORT || 4933);
