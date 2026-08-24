/**
 * @module db/database
 * @description SQLite connection manager for the Agentic Commerce Gateway.
 * 
 * Manages the lifecycle of the SQLite database connection, including:
 * - Creating the data directory if it doesn't exist
 * - Enabling WAL mode for better concurrent read performance
 * - Enabling foreign key enforcement
 * - Running schema migrations
 * - Providing a transaction wrapper for atomic operations
 * 
 * @see docs/backend_schema.md Section 1 — Database Choice
 * @see docs/backend_schema.md Section 6.1 — Connection Management
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * Database manager class — handles SQLite connection, migrations, and transactions.
 */
class DatabaseManager {
  /**
   * Create a new DatabaseManager instance.
   * @param {string} [dbPath] - Path to the SQLite database file.
   *   Defaults to ./data/acg.sqlite relative to project root.
   */
  constructor(dbPath) {
    this.dbPath = dbPath || path.join(__dirname, '..', 'data', 'acg.sqlite');
    this.db = null;
  }

  /**
   * Initialize the database connection and run migrations.
   * Creates the data directory if it doesn't exist.
   * Enables WAL mode and foreign key enforcement.
   * 
   * @returns {DatabaseManager} This instance (for chaining).
   */
  initialize() {
    // Ensure data directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open SQLite connection
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Enable foreign key constraint enforcement
    this.db.pragma('foreign_keys = ON');

    // Run schema migrations
    this.runMigrations();

    return this;
  }

  /**
   * Run all SQL migration files from db/migrations/ in order.
   * Currently runs 001_initial.sql to create the full schema.
   */
  runMigrations() {
    const migrationsDir = path.join(__dirname, 'migrations');

    // Ensure migrations directory exists
    if (!fs.existsSync(migrationsDir)) {
      console.warn('[DatabaseManager] No migrations directory found. Skipping migrations.');
      return;
    }

    // Get all .sql files sorted alphabetically
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, 'utf8');

      try {
        this.db.exec(sql);
        console.log(`[DatabaseManager] Migration applied: ${file}`);
      } catch (err) {
        // If tables already exist, that's fine (IF NOT EXISTS handles it)
        // Only throw on real errors
        if (!err.message.includes('already exists')) {
          throw new Error(`Migration failed (${file}): ${err.message}`);
        }
        console.log(`[DatabaseManager] Migration already applied: ${file}`);
      }
    }
  }

  /**
   * Execute a function within a database transaction.
   * Automatically commits on success or rolls back on error.
   * 
   * @param {Function} fn - Function to execute within the transaction.
   *   Receives the database instance as its argument.
   * @returns {*} The return value of the function.
   * @throws {Error} Re-throws any error from the function after rollback.
   */
  transaction(fn) {
    const transact = this.db.transaction(fn);
    return transact();
  }

  /**
   * Get a prepared statement for a SQL query.
   * Prepared statements are cached by better-sqlite3 for performance.
   * 
   * @param {string} sql - SQL query string with ? placeholders.
   * @returns {Statement} A better-sqlite3 prepared statement.
   */
  prepare(sql) {
    return this.db.prepare(sql);
  }

  /**
   * Execute raw SQL (for DDL or batch operations).
   * 
   * @param {string} sql - SQL to execute.
   */
  exec(sql) {
    this.db.exec(sql);
  }

  /**
   * Close the database connection gracefully.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[DatabaseManager] Database connection closed.');
    }
  }
}

// Export both the class and a singleton factory
module.exports = DatabaseManager;
