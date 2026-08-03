import { getConfig } from './config/env.js';
import { createPool } from './db/pool.js';
import { buildServer } from './http/api.js';

const config = getConfig();
const pool = createPool();
const app = await buildServer(pool);

const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await pool.end();
};

process.once('SIGINT', () => {
  void shutdown();
});

process.once('SIGTERM', () => {
  void shutdown();
});

try {
  await app.listen({ host: config.http.host, port: config.http.port });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exitCode = 1;
}
