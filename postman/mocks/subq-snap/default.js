// Local-only contract subset: https://docs.subq.ai/endpoints/decisions-api/ (2026-10-24).
// No credentials/upstream calls. ?fixture=... is local fault injection, never a vendor field.
const { createServer } = require('node:http');
let rateLimitRequests = 0;
createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' });
    res.end(JSON.stringify(body));
  };
  const fail = (status, error_type, message) => send(status, { detail: { error_type, message } });
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'POST' || url.pathname !== '/v1/systemone') return fail(501, 'unmodeled', 'Unmodeled endpoint');
  try {
    if (req.headers.authorization !== 'Bearer fixture-key') return fail(401, 'unauthorized', 'Invalid API key');
    let body = req.body;
    if (body === undefined) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } else if (typeof body === 'string') body = JSON.parse(body);
    if (body.model !== 'subq-snap-1.1' || body.state === undefined || !body.questions || body.messages || body.assets)
      return fail(422, 'validation_error', 'Invalid request shape');
    const entries = Object.entries(body.questions);
    if (!entries.length || entries.length > 128 || entries.some(([id]) => [...id].length > 100))
      return fail(422, 'validation_error', 'Invalid question count or name');
    let bytes = 0;
    if (body.images !== undefined) {
      if (!Array.isArray(body.images) || body.images.length > 4)
        return fail(422, 'validation_error', 'Too many images');
      for (const image of body.images) {
        if (
          !['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType) ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)
        )
          return fail(422, 'validation_error', 'Invalid image encoding');
        const decoded = Buffer.from(image.base64, 'base64');
        const matches =
          image.mediaType === 'image/png'
            ? decoded.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : image.mediaType === 'image/jpeg'
              ? decoded[0] === 255 && decoded[1] === 216
              : decoded.toString('ascii', 8, 12) === 'WEBP';
        if (!matches || decoded.length > 4 * 1024 * 1024)
          return fail(422, 'validation_error', 'Invalid or oversized image');
        bytes += decoded.length;
      }
    }
    if (bytes > 8 * 1024 * 1024) return fail(422, 'validation_error', 'Too many image bytes');
    const fixture = url.searchParams.get('fixture');
    if (fixture === 'credits') return fail(402, 'insufficient_credits', 'Insufficient credits');
    if (fixture === 'forbidden') return fail(403, 'model_access_denied', 'The API key cannot use the requested model');
    if (fixture === 'rate-limit' && rateLimitRequests++ % 2 === 0) return fail(429, 'rate_limit', 'Try later');
    if (fixture === 'slow') await new Promise((resolve) => setTimeout(resolve, 500));
    const answers = Object.create(null);
    for (const [id, question] of entries) {
      if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.8 };
      else if (question.type === 'choice') {
        const options = Object.keys(question.criteria || {});
        if (options.length < 2 || options.length > 255) return fail(422, 'validation_error', 'Invalid Choice criteria');
        answers[id] = {
          type: 'choice',
          choice: options[0],
          confidence: 1,
          probabilities: Object.fromEntries(options.map((key, i) => [key, i ? 0 : 1])),
        };
      } else if (
        question.type === 'score' &&
        Array.isArray(question.criteria) &&
        question.criteria.length >= 2 &&
        question.criteria.length <= 10
      ) {
        answers[id] = {
          type: 'score',
          score: 0,
          confidence: 1,
          legend: Object.fromEntries(question.criteria.map((value, i) => [i, value])),
          probabilities: Object.fromEntries(question.criteria.map((_, i) => [i, i ? 0 : 1])),
        };
      } else return fail(422, 'validation_error', 'Invalid question');
    }
    return send(200, { model: body.model, answers, usage: { input_tokens: 1000, output_tokens: 0 } });
  } catch {
    return fail(422, 'validation_error', 'Invalid JSON');
  }
}).listen(Number(process.env.PORT || 4922), '127.0.0.1');
