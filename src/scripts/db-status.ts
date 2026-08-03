import { createPool } from '../db/pool.js';

const pool = createPool();

try {
  const result = await pool.query('SELECT current_database() AS db, current_user AS role, current_schema() AS schema');
  console.log(result.rows[0]);
} finally {
  await pool.end();
}
