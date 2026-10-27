const http = require('node:http');

/** Deterministic Decision AI and streaming LLM HTTP fixture; never forwards upstream. */
exports.createCostProviderServer = function createCostProviderServer() {
  const requests = [];
  return http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/__requests') return reply(200, requests);
      if (req.method === 'POST' && req.url === '/__reset') {
        requests.length = 0;
        return reply(200, { reset: true });
      }
      if (req.method !== 'POST' || !['/v1/systemone', '/v1/chat/completions'].includes(req.url))
        return reply(501, { error: 'Not modeled' });
      let body = req.body;
      if (body === undefined) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      if (req.url === '/v1/chat/completions') {
        if (body.model !== 'test/model' || !Array.isArray(body.messages))
          return reply(400, { error: 'Expected LLM request' });
        requests.push({ kind: 'llm', model: body.model, stream: body.stream === true });
        const usage = { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, cost: 0.004 };
        const base = { id: 'cost-chat', model: body.model, created: 1 };
        if (!body.stream)
          return reply(200, {
            ...base,
            object: 'chat.completion',
            usage,
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hello back' }, finish_reason: 'stop' }],
          });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const chunk of [
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello back' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
        ])
          res.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      if (typeof body.model !== 'string' || !body.questions || typeof body.questions !== 'object')
        return reply(400, { error: 'Expected model and question map' });
      requests.push({ model: body.model, questions: Object.keys(body.questions) });
      if (body.model === 'fixture-hold') return; // The test cancels the actual in-flight HTTP request.
      if (body.model === 'fixture-denied') return reply(401, { error: 'Fixture rejection' });
      return reply(200, {
        model: body.model,
        answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.8 }])),
        usage: { input_tokens: 1000, output_tokens: 0 },
      });
    } catch {
      reply(400, { error: 'Invalid fixture request' });
    }
  });
};
