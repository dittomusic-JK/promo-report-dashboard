/**
 * Cloudflare R2 / S3-compatible storage client.
 *
 * Uses AWS Signature V4 signing with zero SDK dependencies.
 * Configured via env vars: BACKUP_S3_BUCKET, BACKUP_S3_REGION,
 * BACKUP_S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
 */

import crypto from 'crypto';
import https from 'https';
import http from 'http';

const S3_BUCKET = process.env.BACKUP_S3_BUCKET;
const S3_REGION = process.env.BACKUP_S3_REGION || 'auto';
const S3_ENDPOINT = process.env.BACKUP_S3_ENDPOINT;
const ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID;
const SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY;

function isConfigured() {
  return !!(S3_BUCKET && ACCESS_KEY && SECRET_KEY);
}

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

function getHost() {
  return S3_ENDPOINT
    ? new URL(S3_ENDPOINT).host
    : `${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
}

function getBasePath() {
  return S3_ENDPOINT ? `/${S3_BUCKET}` : '';
}

function encodeKey(key) {
  return key.split('/').map(s => encodeURIComponent(s)).join('/');
}

function buildUrl(objectKey) {
  const host = getHost();
  const encoded = encodeKey(objectKey);
  return S3_ENDPOINT
    ? `${S3_ENDPOINT}/${S3_BUCKET}/${encoded}`
    : `https://${host}/${encoded}`;
}

function signRequest(method, canonicalUri, queryString, headers, payloadHash) {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = payloadHash;

  const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalHeaders = signedHeaderKeys
    .map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)]}\n`)
    .join('');

  const canonicalRequest = [method, canonicalUri, queryString || '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const signingKey = getSignatureKey(SECRET_KEY, dateStamp, S3_REGION, 's3');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/**
 * Upload a file to R2.
 * @param {string} key - Object key (e.g. 'reports/abc123.json')
 * @param {Buffer|string} body - File content
 * @param {string} contentType - MIME type
 */
function r2Put(key, body, contentType = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
    const host = getHost();
    const canonicalUri = `${getBasePath()}/${encodeKey(key)}`;
    const payloadHash = sha256(bodyBuffer);

    const headers = {
      Host: host,
      'Content-Length': bodyBuffer.length.toString(),
      'Content-Type': contentType,
    };
    signRequest('PUT', canonicalUri, '', headers, payloadHash);

    const parsed = new URL(buildUrl(key));
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(parsed, { method: 'PUT', headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode });
        } else {
          reject(new Error(`R2 PUT ${key} failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

/**
 * Download a file from R2.
 * @param {string} key - Object key
 * @returns {Promise<{body: Buffer, contentType: string, statusCode: number}>}
 */
function r2Get(key) {
  return new Promise((resolve, reject) => {
    const host = getHost();
    const canonicalUri = `${getBasePath()}/${encodeKey(key)}`;
    const payloadHash = sha256('');

    const headers = { Host: host };
    signRequest('GET', canonicalUri, '', headers, payloadHash);

    const parsed = new URL(buildUrl(key));
    const transport = parsed.protocol === 'https:' ? https : http;

    transport.get(parsed, { headers }, (res) => {
      if (res.statusCode === 404) {
        return resolve(null);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({
            body: Buffer.concat(chunks),
            contentType: res.headers['content-type'] || 'application/octet-stream',
            statusCode: res.statusCode,
          });
        } else {
          reject(new Error(`R2 GET ${key} failed (${res.statusCode}): ${Buffer.concat(chunks).toString()}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Delete a file from R2.
 * @param {string} key - Object key
 */
function r2Delete(key) {
  return new Promise((resolve, reject) => {
    const host = getHost();
    const canonicalUri = `${getBasePath()}/${encodeKey(key)}`;
    const payloadHash = sha256('');

    const headers = { Host: host };
    signRequest('DELETE', canonicalUri, '', headers, payloadHash);

    const parsed = new URL(buildUrl(key));
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(parsed, { method: 'DELETE', headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`R2 DELETE ${key} failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * List objects under a prefix.
 * @param {string} prefix - Key prefix (e.g. 'reports/')
 * @returns {Promise<string[]>} - Array of full keys
 */
function r2List(prefix) {
  return new Promise((resolve, reject) => {
    const host = getHost();
    const canonicalUri = `${getBasePath()}/`;
    const queryString = `list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`;
    const payloadHash = sha256('');

    const headers = { Host: host };
    signRequest('GET', canonicalUri, queryString, headers, payloadHash);

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
          const keys = [...data.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
          resolve(keys);
        } else {
          reject(new Error(`R2 LIST failed (${res.statusCode}): ${data}`));
        }
      });
    }).on('error', reject);
  });
}

export { r2Put, r2Get, r2Delete, r2List, isConfigured };
