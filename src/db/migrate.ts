import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createPool, type DbPool } from './pool.js';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const ensureMigrationTable = async (pool: DbPool) => {
  const schema = await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'app'");
  if (!schema.rowCount) {
    await pool.query('CREATE SCHEMA app');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app.schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

export const runMigrations = async (
  pool: DbPool,
  migrationsDir = path.resolve(process.cwd(), 'migrations')
): Promise<MigrationResult> => {
  await ensureMigrationTable(pool);

  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && !file.startsWith('.') && !file.startsWith('._'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const exists = await pool.query('SELECT 1 FROM app.schema_migrations WHERE id = $1', [file]);
    if (exists.rowCount) {
      skipped.push(file);
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO app.schema_migrations (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();

  runMigrations(pool)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .finally(async () => {
      await pool.end();
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
