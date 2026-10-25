// Local-only contract subset from https://docs.typesafe.ai/images (2026-10-24).
// No upstream proxying, credentials or project files. Only Noul is exercised here.
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
    if (Object.values(body.questions).some((question) => question.type !== 'noul'))
      return send(501, { error: 'This local contract fixture exercises only Noul' });
    return send(200, {
      model: 'jev-1.14.0',
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.8 }])),
      usage: { input_tokens: 1000, output_tokens: 0 },
    });
  } catch {
    return send(400, { error: 'Invalid JSON' });
  }
}).listen(Number(process.env.PORT || 4921), '127.0.0.1');
