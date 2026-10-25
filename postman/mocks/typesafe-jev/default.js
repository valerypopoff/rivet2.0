// Local-only contract subset from https://docs.typesafe.ai/images (2026-10-24).
// No upstream proxying, credentials or project files. Noul and Box contract subsets.
const { createServer } = require('node:http');
createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(501, { error: 'Unmodeled endpoint' });
  try {
    let body = req.body;
    if (body === undefined) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } else if (typeof body === 'string') body = JSON.parse(body);
    if (!body || !body.model || !body.questions || body.state === undefined || body.images)
      return send(400, { error: 'Invalid request shape' });
    if (body.assets) {
      if (req.headers['typesafe-danger-zone-images'] !== 'true') return send(400, { error: 'Images not enabled' });
      for (const [reference, asset] of Object.entries(body.assets)) {
        if (
          !reference ||
          !JSON.stringify([body.state, ...Object.values(body.questions)]).includes(reference) ||
          asset.type !== 'image' ||
          !['png', 'jpg', 'jpeg'].includes(asset.format) ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.data_base64)
        )
          return send(400, { error: 'Invalid image asset' });
      }
    }
    const hasBox = Object.values(body.questions).some((question) => question.type === 'box');
    if (Object.values(body.questions).some((question) => !['noul', 'box'].includes(question.type)))
      return send(501, { error: 'This local contract fixture exercises only Noul and Box' });
    if (
      hasBox &&
      (!['jev-1.14.0', 'jev-latest', 'jev-preview'].includes(body.model) ||
        req.headers['typesafe-danger-zone-images'] !== 'true' ||
        !Object.keys(body.assets || {}).length ||
        Object.values(body.questions).some((question) => question.type === 'box' && 'criteria' in question))
    )
      return send(400, { error: 'Invalid Box request' });
    return send(200, {
      model: 'jev-1.14.0',
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => [
          id,
          question.type === 'box'
            ? { type: 'box', box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 }, confidence: 0.92 }
            : { type: 'noul', noul: 0.8 },
        ]),
      ),
      usage: { input_tokens: 1000, output_tokens: hasBox ? 21 : 0 },
    });
  } catch {
    return send(400, { error: 'Invalid JSON' });
  }
}).listen(Number(process.env.PORT || 4921), '127.0.0.1');
