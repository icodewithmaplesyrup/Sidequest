'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected client error:', err.message);
});

/**
 * Run a query.  Pass parameterized values as the second arg to prevent SQL injection.
 * @param {string} text
 * @param {any[]}  [params]
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[db] ${(Date.now() - start)}ms → ${text.slice(0, 80)}`);
  }
  return res;
}

/**
 * Run multiple queries in a single transaction.
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, transaction, pool };
