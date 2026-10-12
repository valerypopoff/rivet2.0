import 'dotenv/config';
import { assertServerDeploymentContract } from './server-deployment-contract.js';

assertServerDeploymentContract();
// Do not import the composition root before deployment validation. Importing it
// installs transports and starts initialization, including potential store writes.
await import('./server.js');
