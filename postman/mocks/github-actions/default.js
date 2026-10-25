const { createServer } = require('node:http');
const { createGitHubActionsHandler } = require('./contract.cjs');
createServer(createGitHubActionsHandler()).listen(Number(process.env.PORT || 4920), '127.0.0.1');
