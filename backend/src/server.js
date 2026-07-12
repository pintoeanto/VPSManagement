import './db/index.js';
import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`[vps-console] listening on ${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
});

function shutdown(signal) {
  console.log(`[vps-console] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
