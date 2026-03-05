#!/usr/bin/env node

/**
 * Backup script for Promo Report Dashboard
 *
 * Archives reports/ and uploads/ into a timestamped .tar.gz and uploads to an
 * S3-compatible bucket. Retains the last N backups (default 30).
 *
 * Required env vars:
 *   BACKUP_S3_BUCKET, BACKUP_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * Optional:
 *   BACKUP_S3_ENDPOINT  – custom endpoint for non-AWS providers
 *   BACKUP_RETENTION    – number of backups to keep (default 30)
 *
 * Usage:
 *   node backup.js              # one-off backup
 *   Render Cron Job / crontab   # scheduled daily
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import crypto from 'crypto';
import https from 'https';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/data' : path.join(__dirname, 'data');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'backups_tmp');

const S3_BUCKET = process.env.BACKUP_S3_BUCKET;
const S3_REGION = process.env.BACKUP_S3_REGION || 'us-east-1';
const S3_ENDPOINT = process.env.BACKUP_S3_ENDPOINT;
const ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID;
const SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const RETENTION = parseInt(process.env.BACKUP_RETENTION || '30', 10);
const PREFIX = 'promo-dashboard-backups/';

// --- Helpers ---

function hmacSHA256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function getSignatureKey(key, dateStamp, region, service) {
  const kDate = hmacSHA256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSHA256(kDate, region);
  const kService = hmacSHA256(kRegion, service);
  return hmacSHA256(kService, 'aws4_request');
}

/**
 * Minimal AWS Signature V4 PUT request (no SDK dependency).
 */
function s3Put(objectKey, filePath) {
  return new Promise((resolve, reject) => {
    const body = fs.readFileSync(filePath);
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

    const host = S3_ENDPOINT
      ? new URL(S3_ENDPOINT).host
      : `${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
    const basePath = S3_ENDPOINT ? `/${S3_BUCKET}` : '';
    const canonicalUri = `${basePath}/${objectKey}`;
    const payloadHash = sha256(body);

    const headers = {
      Host: host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Content-Length': body.length.toString(),
      'Content-Type': 'application/gzip',
    };

    const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
    const signedHeaders = signedHeaderKeys.join(';');
    const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)]}\n`).join('');

    const canonicalRequest = [
      'PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
    const signingKey = getSignatureKey(SECRET_KEY, dateStamp, S3_REGION, 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = S3_ENDPOINT
      ? `${S3_ENDPOINT}/${S3_BUCKET}/${objectKey}`
      : `https://${host}/${objectKey}`;

    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(parsed, { method: 'PUT', headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode });
        } else {
          reject(new Error(`S3 PUT failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Minimal S3 LIST (GET Bucket) with prefix.
 */
function s3List() {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

    const host = S3_ENDPOINT
      ? new URL(S3_ENDPOINT).host
      : `${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
    const basePath = S3_ENDPOINT ? `/${S3_BUCKET}` : '';
    const canonicalUri = `${basePath}/`;
    const queryString = `list-type=2&prefix=${encodeURIComponent(PREFIX)}`;
    const payloadHash = sha256('');

    const headers = {
      Host: host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
    const signedHeaders = signedHeaderKeys.join(';');
    const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)]}\n`).join('');

    const canonicalRequest = ['GET', canonicalUri, queryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
    const signingKey = getSignatureKey(SECRET_KEY, dateStamp, S3_REGION, 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = S3_ENDPOINT
      ? `${S3_ENDPOINT}/${S3_BUCKET}/?${queryString}`
      : `https://${host}/?${queryString}`;

    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    transport.get(parsed, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Parse keys from XML response
          const keys = [...data.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
          resolve(keys);
        } else {
          reject(new Error(`S3 LIST failed (${res.statusCode}): ${data}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Minimal S3 DELETE.
 */
function s3Delete(objectKey) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

    const host = S3_ENDPOINT
      ? new URL(S3_ENDPOINT).host
      : `${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
    const basePath = S3_ENDPOINT ? `/${S3_BUCKET}` : '';
    const canonicalUri = `${basePath}/${objectKey}`;
    const payloadHash = sha256('');

    const headers = {
      Host: host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
    const signedHeaders = signedHeaderKeys.join(';');
    const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)]}\n`).join('');

    const canonicalRequest = ['DELETE', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
    const signingKey = getSignatureKey(SECRET_KEY, dateStamp, S3_REGION, 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = S3_ENDPOINT
      ? `${S3_ENDPOINT}/${S3_BUCKET}/${objectKey}`
      : `https://${host}/${objectKey}`;

    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(parsed, { method: 'DELETE', headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`S3 DELETE failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- Main ---

async function runBackup() {
  console.log('🔄 Starting backup...');

  // Validate config
  if (!S3_BUCKET || !ACCESS_KEY || !SECRET_KEY) {
    console.error('❌ Missing required env vars: BACKUP_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY');
    process.exit(1);
  }

  // Check source directories
  if (!fs.existsSync(REPORTS_DIR) && !fs.existsSync(UPLOADS_DIR)) {
    console.error('❌ No data directories found to back up');
    process.exit(1);
  }

  // Create temp dir
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveName = `backup-${timestamp}.tar.gz`;
  const archivePath = path.join(TMP_DIR, archiveName);

  try {
    // Create tar.gz archive
    console.log('  📦 Creating archive...');
    const dirs = [];
    if (fs.existsSync(REPORTS_DIR)) dirs.push('reports');
    if (fs.existsSync(UPLOADS_DIR)) dirs.push('uploads');

    execSync(`tar -czf "${archivePath}" -C "${DATA_DIR}" ${dirs.join(' ')}`, { stdio: 'pipe' });

    const sizeMB = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(2);
    console.log(`  📦 Archive created: ${archiveName} (${sizeMB} MB)`);

    // Upload to S3
    const objectKey = `${PREFIX}${archiveName}`;
    console.log(`  ☁️  Uploading to s3://${S3_BUCKET}/${objectKey}...`);
    await s3Put(objectKey, archivePath);
    console.log('  ✅ Upload complete');

    // Clean up local temp file
    fs.unlinkSync(archivePath);

    // Retention: list existing backups and delete oldest beyond limit
    console.log(`  🗑️  Enforcing retention (keep last ${RETENTION})...`);
    const keys = await s3List();
    const backupKeys = keys.filter(k => k.startsWith(PREFIX) && k.endsWith('.tar.gz')).sort();

    if (backupKeys.length > RETENTION) {
      const toDelete = backupKeys.slice(0, backupKeys.length - RETENTION);
      for (const key of toDelete) {
        console.log(`     Deleting old backup: ${key}`);
        await s3Delete(key);
      }
    }

    console.log(`✅ Backup complete! ${backupKeys.length} total backups in bucket.`);
    return { success: true, archive: archiveName, sizeMB, totalBackups: backupKeys.length };

  } catch (error) {
    // Clean up on failure
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    console.error('❌ Backup failed:', error.message);
    throw error;
  }
}

// Run if executed directly
runBackup().catch(() => process.exit(1));

export { runBackup };
