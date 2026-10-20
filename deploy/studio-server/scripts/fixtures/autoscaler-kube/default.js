// Local-only failure fixture for the documented Kubernetes HTTP transport.
// Full stateful HTTP+exec protocol coverage lives beside the controller tests.
const http = require('node:http');
http
  .createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/hang') return;
    if (path === '/html-error') {
      res.writeHead(502, { 'content-type': 'text/html' });
      return res.end('<html>upstream unavailable</html>');
    }
    res.setHeader('content-type', 'application/json');
    if (path === '/json-error') {
      res.statusCode = 503;
      return res.end('{"kind":"Status","status":"Failure"}');
    }
    if (path === '/missing') {
      res.statusCode = 404;
      return res.end('{"kind":"Status","reason":"NotFound"}');
    }
    if (path === '/ok') return res.end('{"kind":"APIResourceList"}');
    res.statusCode = 501;
    res.end('{"error":"not modeled by this local fixture"}');
  })
  .listen(process.env.PORT);
