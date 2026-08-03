import pg from 'pg';

import { getConfig } from '../config/env.js';

const { Pool } = pg;

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;

export const createPool = (): DbPool => {
  const config = getConfig();

  return new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
    max: 8,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 3_000
  });
};
