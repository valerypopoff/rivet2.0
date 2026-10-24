const { createServer } = require('node:http');
const { createPagesHandler } = require('./contract.cjs');

createServer(createPagesHandler()).listen(Number(process.env.PORT || 4919), '127.0.0.1');
