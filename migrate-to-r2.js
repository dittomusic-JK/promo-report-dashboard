#!/usr/bin/env node

/**
 * One-time migration: upload existing reports and uploads to R2.
 *
 * Usage:
 *   node migrate-to-r2.js                    # migrate from local ./data
 *   node migrate-to-r2.js /path/to/backup.tar.gz  # migrate from a backup archive
 *
 * Required env vars: BACKUP_S3_BUCKET, BACKUP_S3_REGION, BACKUP_S3_ENDPOINT,
 *                    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { r2Put, r2List, isConfigured } from './r2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

async function migrate() {
  if (!isConfigured()) {
    console.error('❌ Missing R2 env vars');
    process.exit(1);
  }

  const backupPath = process.argv[2];
  let dataDir;

  if (backupPath) {
    // Extract backup to temp dir
    console.log(`📦 Extracting ${backupPath}...`);
    dataDir = '/tmp/r2-migrate';
    if (fs.existsSync(dataDir)) execSync(`rm -rf "${dataDir}"`);
    fs.mkdirSync(dataDir, { recursive: true });
    execSync(`tar -xzf "${backupPath}" -C "${dataDir}"`, { stdio: 'pipe' });
  } else {
    dataDir = path.join(__dirname, 'data');
  }

  const reportsDir = path.join(dataDir, 'reports');
  const uploadsDir = path.join(dataDir, 'uploads');

  // Check what's already in R2
  console.log('🔍 Checking existing R2 contents...');
  const existingReports = new Set(await r2List('reports/'));
  const existingUploads = new Set(await r2List('uploads/'));
  console.log(`   ${existingReports.size} reports and ${existingUploads.size} uploads already in R2`);

  // Migrate reports
  if (fs.existsSync(reportsDir)) {
    const reportFiles = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json'));
    console.log(`\n📄 Migrating ${reportFiles.length} reports...`);

    let uploaded = 0, skipped = 0;
    for (const file of reportFiles) {
      const key = `reports/${file}`;
      if (existingReports.has(key)) {
        skipped++;
        continue;
      }
      const content = fs.readFileSync(path.join(reportsDir, file));
      await r2Put(key, content, 'application/json');
      uploaded++;
      if (uploaded % 10 === 0) console.log(`   ${uploaded} uploaded...`);
    }
    console.log(`   ✅ ${uploaded} uploaded, ${skipped} skipped (already exist)`);
  }

  // Migrate uploads
  if (fs.existsSync(uploadsDir)) {
    const uploadFiles = fs.readdirSync(uploadsDir);
    console.log(`\n🖼️  Migrating ${uploadFiles.length} uploads...`);

    let uploaded = 0, skipped = 0;
    for (const file of uploadFiles) {
      const key = `uploads/${file}`;
      if (existingUploads.has(key)) {
        skipped++;
        continue;
      }
      const content = fs.readFileSync(path.join(uploadsDir, file));
      await r2Put(key, content, getMimeType(file));
      uploaded++;
      if (uploaded % 20 === 0) console.log(`   ${uploaded} uploaded...`);
    }
    console.log(`   ✅ ${uploaded} uploaded, ${skipped} skipped (already exist)`);
  }

  // Clean up temp dir
  if (backupPath && fs.existsSync('/tmp/r2-migrate')) {
    execSync('rm -rf /tmp/r2-migrate');
  }

  console.log('\n✅ Migration complete!');
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
