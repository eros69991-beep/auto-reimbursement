import { app } from './app.js';
import { loadConfig } from './config.js';
import { resolve } from 'node:path';

const config = loadConfig(process.env, resolve(process.cwd(), '../..'));

app.listen(config.port, config.host, () => {
  console.log(`API listening on ${config.host}:${config.port}`);
});
