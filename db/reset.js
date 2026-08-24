/**
 * @module db/reset
 * @description Development reset script for the Agentic Commerce Gateway.
 * 
 * Drops the existing database, re-runs all migrations, and re-seeds
 * with demo data. This gives a clean slate for development and demo runs.
 * 
 * Usage:
 *   node db/reset.js
 *   npm run reset-db
 * 
 * @see docs/backend_schema.md Section 8.1 — Reset Script
 */

const fs = require('fs');
const path = require('path');
const DatabaseManager = require('./database');
const { seed } = require('./seed');

/**
 * Reset the database: delete → create → migrate → seed.
 */
function resetDatabase() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'acg.sqlite');

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🔄 ACG Database Reset');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Step 1: Delete existing database file
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log(`  ✓ Deleted existing database: ${dbPath}`);

    // Also delete WAL and SHM files if they exist
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  } else {
    console.log(`  ℹ No existing database found at: ${dbPath}`);
  }

  // Step 2: Initialize fresh database (creates dir + runs migrations)
  const dbManager = new DatabaseManager(dbPath);
  dbManager.initialize();
  console.log('  ✓ Created fresh database with schema');

  // Step 3: Seed demo data
  seed(dbManager.db);

  // Step 4: Run health check
  console.log('  🏥 Running health check...');
  const healthCheck = dbManager.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM merchants) as merchant_count,
      (SELECT COUNT(*) FROM products) as product_count,
      (SELECT COUNT(*) FROM variants) as variant_count,
      (SELECT COUNT(*) FROM delegators) as delegator_count,
      (SELECT COUNT(*) FROM agents) as agent_count,
      (SELECT COUNT(*) FROM mandates) as mandate_count,
      (SELECT COUNT(*) FROM transactions) as transaction_count,
      (SELECT COUNT(*) FROM audit_entries) as audit_entry_count
  `).get();

  console.log('');
  console.log('  📋 Health Check Results:');
  console.log(`     Merchants:     ${healthCheck.merchant_count}`);
  console.log(`     Products:      ${healthCheck.product_count}`);
  console.log(`     Variants:      ${healthCheck.variant_count}`);
  console.log(`     Delegators:    ${healthCheck.delegator_count}`);
  console.log(`     Agents:        ${healthCheck.agent_count}`);
  console.log(`     Mandates:      ${healthCheck.mandate_count}`);
  console.log(`     Transactions:  ${healthCheck.transaction_count}`);
  console.log(`     Audit Entries: ${healthCheck.audit_entry_count}`);

  // Step 5: Verify immutability triggers
  console.log('');
  console.log('  🔒 Verifying audit immutability triggers...');
  
  // Insert a test audit entry
  const { v4: uuidv4 } = require('uuid');
  const testEntryId = uuidv4();
  const testTrailId = uuidv4();
  
  dbManager.db.prepare(`
    INSERT INTO audit_entries (entry_id, audit_trail_id, step, data)
    VALUES (?, ?, 'REQUEST', '{"test": true}')
  `).run(testEntryId, testTrailId);

  // Try to update — should fail
  try {
    dbManager.db.prepare(`
      UPDATE audit_entries SET data = '{"tampered": true}' WHERE entry_id = ?
    `).run(testEntryId);
    console.log('  ✗ FAILED: Audit UPDATE should have been blocked!');
  } catch (err) {
    if (err.message.includes('immutable')) {
      console.log('  ✓ Audit UPDATE correctly blocked by trigger');
    } else {
      console.log(`  ✗ Unexpected error: ${err.message}`);
    }
  }

  // Try to delete — should fail
  try {
    dbManager.db.prepare(`
      DELETE FROM audit_entries WHERE entry_id = ?
    `).run(testEntryId);
    console.log('  ✗ FAILED: Audit DELETE should have been blocked!');
  } catch (err) {
    if (err.message.includes('immutable')) {
      console.log('  ✓ Audit DELETE correctly blocked by trigger');
    } else {
      console.log(`  ✗ Unexpected error: ${err.message}`);
    }
  }

  // Close connection
  dbManager.close();

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ Database reset complete!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

// Run when executed directly
resetDatabase();
