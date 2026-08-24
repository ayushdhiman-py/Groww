// Preloaded via `--import` on the `npm test` invocation (Node forwards CLI
// flags, including --import, to each per-file subprocess `node --test`
// spawns, so this runs before ANY test file's imports).
//
// Points the learning layer at a dedicated test database, completely
// separate from the real data/learning.db the live server reads and
// writes. This matters most for destructive operations like
// daily_learning_job.mjs's retention pruning (DELETE ... WHERE trade_date <
// cutoff) — without this, running the test suite against a date like
// "2026-08-19" would prune real historical snapshots/outcomes older than
// ~180 days before that date out of the PRODUCTION database.
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.LEARNING_DB_PATH = path.join(__dirname, "..", "data", "learning.test.db");
