// ─────────────────────────────────────────────────────────────────────────────
// ai_scanner_db.mjs — persistence for the AI tab's Layer 6 (Validation &
// Survival). Deliberately a SEPARATE database file from learning_db.mjs: that
// system validates a completely different object (the Opportunity Score used
// by Critical/Quality tabs), not this tab's 20-minute joint probability
// P(Target before SL). Keeping them separate means neither pipeline can ever
// corrupt or contend with the other's data, matching how every other tab
// this session (Intraday, Screener, All Stocks) stays fully independent.
//
// Same engine/pattern as learning_db.mjs: Node's built-in node:sqlite
// (DatabaseSync, requires Node >= 22.5) — zero new npm dependencies.
//
// MIGRATIONS: CREATE TABLE IF NOT EXISTS only handles brand-new tables — it
// silently no-ops on a table that already exists, even if its column list
// changed since. New columns added after the first ship therefore need an
// explicit idempotent ALTER TABLE ADD COLUMN, wrapped so "duplicate column"
// (already applied) is the one error this swallows — everything else still
// surfaces. There is still no rename/drop migration framework; only ever
// append new nullable columns.
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { __dirname } from "./config.mjs";

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = process.env.AI_SCANNER_DB_PATH ? path.resolve(process.env.AI_SCANNER_DB_PATH) : path.join(DATA_DIR, "ai_scanner.db");

let db = null;

const SCHEMA_SQL = `
-- Layer 3 survivors, logged the instant they're flagged — the full feature
-- vector AND entry state at that moment, so Layer 6 can later ask "given
-- exactly what this candidate looked like, what actually happened."
CREATE TABLE IF NOT EXISTS ai_candidates (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  source                   TEXT NOT NULL DEFAULT 'live',
  data_version             TEXT,
  scanned_at               INTEGER NOT NULL,
  trade_date               TEXT NOT NULL,
  symbol                   TEXT NOT NULL,
  sector                   TEXT,
  market_cap_category      TEXT,
  data_tier                TEXT NOT NULL,
  direction                TEXT NOT NULL,
  entry_price              REAL NOT NULL,
  entry_price_ts           INTEGER,
  entry_price_source       TEXT,
  target_pct               REAL NOT NULL,
  sl_pct                   REAL NOT NULL,
  target_price             REAL NOT NULL,
  sl_price                 REAL NOT NULL,
  setup_score              REAL NOT NULL,
  regime_bias              TEXT,
  index_regime             TEXT,
  vix_value                REAL,
  movement_capacity_score  REAL,
  structure_alignment_json TEXT,
  vwap_state_json          TEXT,
  compression_state        TEXT,
  breakout_quality         REAL,
  momentum_accel           REAL,
  fakeout_score            REAL,
  order_flow_json          TEXT,
  order_flow_is_proxy      INTEGER NOT NULL,
  catalyst_status          TEXT NOT NULL,
  liquidity_impact_cost_pct REAL,
  spread_pct               REAL,
  execution_quality        REAL,
  model_version_at_scan    INTEGER,
  rank_score               REAL,
  breakdown_json           TEXT NOT NULL,
  created_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_candidates_date ON ai_candidates(trade_date);
CREATE INDEX IF NOT EXISTS idx_ai_candidates_symbol ON ai_candidates(symbol);
CREATE INDEX IF NOT EXISTS idx_ai_candidates_scanned_at ON ai_candidates(scanned_at);

-- One row per candidate, written once ~20 minutes later by the outcome
-- sweep (src/ai_scanner.mjs's sweepPendingOutcomes). This IS the label data
-- Layer 6's calibration check compares claimed probabilities against.
-- The window is anchored to entry_price_ts (the LTP tick's own timestamp),
-- NOT scanned_at (server wall-clock) — see sweepPendingOutcomes for why.
CREATE TABLE IF NOT EXISTS ai_outcomes (
  candidate_id             INTEGER PRIMARY KEY REFERENCES ai_candidates(id),
  resolved_at              INTEGER NOT NULL,
  resolution               TEXT NOT NULL,
  time_to_resolution_sec   INTEGER,
  mfe_pct                  REAL,
  mae_pct                  REAL,
  final_price              REAL,
  final_price_pct          REAL,
  path_source_tf           TEXT NOT NULL,
  ambiguous_same_candle    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_outcomes_resolved_at ON ai_outcomes(resolved_at);

-- Every symbol Layer 0/1/2 could NOT evaluate or hard-eliminated, with why —
-- spec Rule 3 requires insufficient-data candidates to be explicitly
-- surfaced as INVALID, not silently dropped. One row per scan cycle per
-- rejected symbol (not accumulated forever — see PRUNE in ai_scanner.mjs).
CREATE TABLE IF NOT EXISTS ai_invalid_log (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_at               INTEGER NOT NULL,
  symbol                   TEXT NOT NULL,
  layer                    TEXT NOT NULL,
  reason                   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_invalid_scanned_at ON ai_invalid_log(scanned_at);

-- Layer 6's model-version registry — mirrors model_registry.mjs's
-- PROPOSED/PRODUCTION pattern in spirit, but for THIS pipeline's joint
-- probability model, and manual-promotion-only for the same reason (real
-- capital, per Rule 8's ban on ever running unvalidated inference).
-- status values: CANDIDATE (produced by runLayer6Validation, not yet
-- promoted) -> VALIDATED (manually promoted via validateModelVersion) ->
-- DEGRADED (kill-switch tripped by killSwitchCheck) / ARCHIVED (superseded).
CREATE TABLE IF NOT EXISTS ai_model_versions (
  version_id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at               INTEGER NOT NULL,
  status                   TEXT NOT NULL,
  training_sample_count    INTEGER,
  validation_sample_count  INTEGER,
  feature_names_json       TEXT,
  calibration_json         TEXT,
  walkforward_json         TEXT,
  montecarlo_json          TEXT,
  regime_backtest_json     TEXT,
  mfe_mae_dist_json        TEXT,
  drift_json               TEXT,
  paper_trade_count        INTEGER,
  notes                    TEXT,
  validated_at             INTEGER,
  validated_by             TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_one_validated
  ON ai_model_versions(status) WHERE status = 'VALIDATED';
`;

// symbol, table, column, type — every column added after first ship goes here.
const MIGRATIONS = [
    ["ai_candidates", "entry_price_ts", "INTEGER"],
    ["ai_candidates", "entry_price_source", "TEXT"],
    ["ai_candidates", "index_regime", "TEXT"],
    ["ai_candidates", "vix_value", "REAL"],
    ["ai_candidates", "execution_quality", "REAL"],
    ["ai_candidates", "rank_score", "REAL"],
    ["ai_candidates", "source", "TEXT NOT NULL DEFAULT 'live'"],
    ["ai_candidates", "data_version", "TEXT"],
    ["ai_model_versions", "feature_names_json", "TEXT"],
    ["ai_model_versions", "regime_backtest_json", "TEXT"],
    ["ai_model_versions", "mfe_mae_dist_json", "TEXT"],
];

function runMigrations(database) {
    for (const [table, column, type] of MIGRATIONS) {
        try {
            database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        } catch (e) {
            if (!/duplicate column/i.test(e.message)) throw e;
        }
    }
    // Indexes on migrated columns must be created AFTER the migrations that
    // add those columns run — SCHEMA_SQL executes first and would otherwise
    // fail on a fresh-vs-existing DB mismatch ("no such column").
    database.exec("CREATE INDEX IF NOT EXISTS idx_ai_candidates_source ON ai_candidates(source);");
}

export function getDb() {
    if (db) return db;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_FILE);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    return db;
}

export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

export { DB_FILE };
