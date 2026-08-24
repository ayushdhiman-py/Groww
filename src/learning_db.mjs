// ─────────────────────────────────────────────────────────────────────────────
// learning_db.mjs — SQLite foundation for the self-improving learning layer.
//
// Uses Node's BUILT-IN node:sqlite module (requires Node >= 22.5 — this is
// why render.yaml's NODE_VERSION was bumped 18.x -> 22.x) so this subsystem
// needs zero new npm dependencies and no native-module compilation risk on
// Render's build.
//
// This file is completely inert on its own: nothing else in the codebase
// imports it yet until src/learning_capture.mjs (Phase 1) starts writing to
// it. Every table is created with IF NOT EXISTS, so re-running on every
// process boot is always safe.
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { __dirname } from "./config.mjs";

const DATA_DIR = path.join(__dirname, "..", "data");
// LEARNING_DB_PATH lets the test suite (see test/setup.mjs) point this at a
// completely separate file so destructive test operations (retention
// pruning) never touch the real production database.
const DB_FILE = process.env.LEARNING_DB_PATH ? path.resolve(process.env.LEARNING_DB_PATH) : path.join(DATA_DIR, "learning.db");

let db = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS snapshots (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date              TEXT NOT NULL,
  capture_ts              INTEGER NOT NULL,
  time_bucket             TEXT NOT NULL,
  symbol                  TEXT NOT NULL,
  sector                  TEXT,
  market_cap_category     TEXT,
  market_regime           TEXT,
  open                    REAL,
  ltp                     REAL,
  move_from_open_pct      REAL,
  vwap                    REAL,
  relative_volume         REAL,
  rsi                     REAL,
  macd                    REAL,
  macd_histogram          REAL,
  ema9                    REAL,
  ema21                   REAL,
  ema50                   REAL,
  atr_pct                 REAL,
  orb_state               TEXT,
  relative_strength_pp    REAL,
  sector_strength         REAL,
  price_action_state      TEXT,
  trap_risk               TEXT,
  exhaustion_risk         TEXT,
  opportunity_score       INTEGER,
  opportunity_band        TEXT,
  entry_attractiveness    INTEGER,
  estimated_upside_pct    REAL,
  remaining_upside_pct    REAL,
  upside_confidence       TEXT,
  breakdown_json          TEXT NOT NULL,
  was_taken               INTEGER NOT NULL DEFAULT 0,
  linked_critical_trade_id TEXT,
  created_at              INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_snapshot_symbol_date_bucket
  ON snapshots(trade_date, symbol, time_bucket);
CREATE INDEX IF NOT EXISTS idx_snapshot_date ON snapshots(trade_date);
CREATE INDEX IF NOT EXISTS idx_snapshot_symbol ON snapshots(symbol);

CREATE TABLE IF NOT EXISTS outcomes (
  snapshot_id             INTEGER PRIMARY KEY REFERENCES snapshots(id),
  trade_date              TEXT NOT NULL,
  symbol                  TEXT NOT NULL,
  final_close             REAL,
  maximum_high            REAL,
  maximum_low             REAL,
  mfe_pct                 REAL,
  mae_pct                 REAL,
  close_vs_open_pct       REAL,
  close_vs_snapshot_pct   REAL,
  reached_1pct            INTEGER,
  reached_2pct            INTEGER,
  reached_2_5pct          INTEGER,
  reached_5pct            INTEGER,
  close_above_open        INTEGER,
  major_reversal          INTEGER,
  profit_giveback         INTEGER,
  thesis_failure          INTEGER,
  finalized_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_date ON outcomes(trade_date);

CREATE TABLE IF NOT EXISTS model_versions (
  version_id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at                INTEGER NOT NULL,
  status                    TEXT NOT NULL,
  training_period_from      TEXT,
  training_period_to        TEXT,
  validation_period_from    TEXT,
  validation_period_to      TEXT,
  training_sample_count     INTEGER,
  validation_sample_count   INTEGER,
  weights_json              TEXT NOT NULL,
  metrics_json              TEXT,
  promoted_at               INTEGER,
  promoted_by               TEXT,
  notes                     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_production
  ON model_versions(status) WHERE status = 'PRODUCTION';

CREATE TABLE IF NOT EXISTS rolling_stats (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date               TEXT NOT NULL,
  segment_key              TEXT NOT NULL,
  segment_json             TEXT NOT NULL,
  window                   TEXT NOT NULL,
  sample_count             INTEGER NOT NULL,
  win_rate                 REAL,
  prob_reach_1pct          REAL,
  prob_reach_2pct          REAL,
  prob_reach_2_5pct        REAL,
  prob_reach_5pct          REAL,
  prob_major_adverse       REAL,
  prob_momentum_deterioration REAL,
  prob_profit_giveback     REAL,
  sufficient_sample        INTEGER NOT NULL,
  created_at               INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rolling_stats
  ON rolling_stats(as_of_date, segment_key, window);

CREATE TABLE IF NOT EXISTS drift_log (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at               INTEGER NOT NULL,
  segment_key              TEXT NOT NULL,
  recent_win_rate          REAL,
  historical_win_rate      REAL,
  delta                    REAL,
  recent_sample_count      INTEGER,
  historical_sample_count  INTEGER,
  flagged                  INTEGER NOT NULL,
  notes                    TEXT
);

CREATE TABLE IF NOT EXISTS job_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date      TEXT NOT NULL UNIQUE,
  started_at    INTEGER,
  finished_at   INTEGER,
  status        TEXT,
  error         TEXT
);
`;

/**
 * Returns the singleton learning-layer database, opening + migrating it on
 * first call. Safe to call repeatedly (every table/index creation is
 * idempotent). Throws if the file/directory can't be created or opened —
 * callers that must never let this break the live scanner (learning_capture,
 * entry_score's weight lookup) wrap calls to this in their own try/catch.
 */
export function getDb() {
    if (db) return db;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_FILE);
    db.exec("PRAGMA journal_mode = WAL;");
    // Without a busy timeout, a concurrent writer (e.g. two Node processes —
    // this matters for `node --test`, which runs test files in separate
    // processes, and in production if the daily job and a scan-cycle write
    // ever land in the same instant) gets an immediate SQLITE_BUSY error
    // instead of waiting briefly for the lock to clear.
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA_SQL);
    return db;
}

/** Test/ops helper — closes and clears the singleton so a fresh getDb() reopens. */
export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

export { DB_FILE };
