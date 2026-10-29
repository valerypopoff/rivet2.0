const { createServer } = require('node:http');
const { handler } = require('./contract.cjs');
createServer(handler()).listen(Number(process.env.PORT || 4942), '127.0.0.1');
