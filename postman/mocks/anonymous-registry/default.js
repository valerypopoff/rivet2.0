const { createServer } = require('node:http');
const { handler } = require('./contract.cjs');
createServer(handler).listen(Number(process.env.PORT || 4943), '127.0.0.1');
