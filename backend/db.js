// db.js — PostgreSQL connection pool
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME     || 'MyWork_db',
        user:     process.env.DB_USER     || 'sweet_p',
        password: process.env.DB_PASSWORD || '',
      }
);

const DDL = `
  CREATE TABLE IF NOT EXISTS residents (
    id             SERIAL PRIMARY KEY,
    rank           TEXT NOT NULL,
    first_name     TEXT NOT NULL,
    last_name      TEXT NOT NULL,
    room_number    TEXT NOT NULL,
    floor_number   INTEGER NOT NULL,
    family_head    TEXT NOT NULL DEFAULT 'self',
    resident_count INTEGER NOT NULL DEFAULT 0,
    position       TEXT,
    unit           TEXT,
    birthdate      DATE,
    id_card_address TEXT,
    phone          TEXT,
    created_at     TIMESTAMP DEFAULT NOW(),
    updated_at     TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS family_members (
    id               SERIAL PRIMARY KEY,
    resident_id      INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
    prefix           TEXT NOT NULL,
    first_name       TEXT NOT NULL,
    last_name        TEXT NOT NULL,
    relationship     TEXT NOT NULL,
    birthdate        DATE,
    id_card_address  TEXT,
    work_address     TEXT,
    phone            TEXT
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id            SERIAL PRIMARY KEY,
    resident_id   INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
    type          TEXT NOT NULL CHECK (type IN ('car','motorcycle')),
    plate_number  TEXT NOT NULL,
    plate_province TEXT,
    brand         TEXT,
    color         TEXT
  );
`;

async function initDB() {
  await pool.query(DDL);
  console.log('✅  Database tables ready');
  return pool;
}

module.exports = { initDB };
