/**
 * Ditto Promo hub (promo.dittomusic.com) integration.
 *
 * The hub is a Laravel app. Its front end calls two kinds of route:
 *   /api/admin/...        token-authenticated (Authorization: Bearer <api_token>)
 *   /questionnaire/{id}   web route, needs the browser session cookie
 * Campaign lists come from the token-authenticated API. Questionnaire answers
 * only exist on the web route until the hub team exposes them under /api/admin,
 * so HUB_COOKIE (a staff session cookie) can be supplied as an interim bridge.
 *
 * Auth, in order of preference:
 *   HUB_AUTH_EMAIL + HUB_AUTH_PASSWORD  a service account that logs in to dashboard2's
 *       /authentication_token (same pattern as ditto-web's Trends client). The JWT lasts
 *       weeks; it is cached in memory and renewed shortly before it expires, or on a 401.
 *   HUB_API_TOKEN                       a static bearer token, if the hub team issues one.
 * Optional: HUB_COOKIE (interim session bridge, "laravel_session=..."),
 *           HUB_AUTH_URL (default https://dashboard2.dittomusic.com/authentication_token),
 *           HUB_BASE_URL (default https://promo.dittomusic.com)
 */
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const HUB_BASE = (process.env.HUB_BASE_URL || 'https://promo.dittomusic.com').replace(/\/$/, '');
const STATIC_TOKEN = process.env.HUB_API_TOKEN || '';
// The shared Ditto service account is fine here; its Trends variable names are accepted as-is
const AUTH_EMAIL = process.env.HUB_AUTH_EMAIL || process.env.DITTO_TRENDS_EMAIL || '';
const AUTH_PASSWORD = process.env.HUB_AUTH_PASSWORD || process.env.DITTO_TRENDS_PASSWORD || '';
const AUTH_URL = process.env.HUB_AUTH_URL || 'https://dashboard2.dittomusic.com/authentication_token';
const COOKIE = process.env.HUB_COOKIE || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const hubConfigured = () => !!(STATIC_TOKEN || (AUTH_EMAIL && AUTH_PASSWORD));
export const hubAuthMode = () => (AUTH_EMAIL && AUTH_PASSWORD) ? 'service-account' : STATIC_TOKEN ? 'static-token' : 'none';

// ---- service-account login with an in-memory token cache
// dashboard2 returns { token, refreshToken }. The JWT lasts about a month. Refresh tokens are
// single-use and rotate on every refresh, so the newest one is kept here in memory only: this
// service runs as one instance, and if the process restarts (or a refresh is refused) we simply
// log in with the credentials again, which is the fallback the dashboard2 team recommends.
const REFRESH_URL = process.env.HUB_REFRESH_URL || AUTH_URL.replace(/\/authentication_token$/, '/api/token/refresh');
let cache = null;      // { token, exp, refreshToken }
let inFlight = null;
const jwtExp = jwt => { try { return JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).exp || 0; } catch { return 0; } };
async function login() {
  const res = await fetch(AUTH_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify({ email: AUTH_EMAIL, password: AUTH_PASSWORD }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Hub service login failed (${res.status}). Check HUB_AUTH_EMAIL / HUB_AUTH_PASSWORD and that the account allows credentials login.`);
  return remember(await res.json(), 'login');
}
function remember(j, how) {
  const token = j.token ?? j.access_token;
  if (!token) throw new Error(`Hub service ${how} returned no token`);
  cache = { token, exp: jwtExp(token) || (Date.now() / 1000 + 3000), refreshToken: j.refreshToken || j.refresh_token || null };
  return token;
}
async function refresh() {
  const res = await fetch(REFRESH_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify({ refreshToken: cache.refreshToken }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`refresh refused (${res.status})`);
  return remember(await res.json(), 'refresh');
}
// Renew: use the refresh token when we hold one, otherwise (or if it is refused) log in again
async function renew() {
  if (cache?.refreshToken) { try { return await refresh(); } catch (err) { console.warn('Hub token refresh failed, logging in again:', err.message); } }
  return login();
}
async function getToken(forceNew = false) {
  if (!(AUTH_EMAIL && AUTH_PASSWORD)) return STATIC_TOKEN;
  const now = Date.now() / 1000;
  if (!forceNew && cache && cache.exp - 300 > now) return cache.token;
  if (inFlight) return inFlight;
  inFlight = renew().finally(() => { inFlight = null; });
  return inFlight;
}

async function hubGet(p, retried = false) {
  const headers = { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', authorization: `Bearer ${await getToken()}`, 'user-agent': UA };
  if (COOKIE) headers.cookie = COOKIE;
  const res = await fetch(`${HUB_BASE}${p}`, { headers, redirect: 'manual' });
  // A cached service token can be revoked early; log in again once before giving up
  if (res.status === 401 && !retried && AUTH_EMAIL && AUTH_PASSWORD) { await getToken(true); return hubGet(p, true); }
  if (res.status === 401 || res.status === 419 || res.status === 302) throw new Error(p.startsWith('/api/') ? 'The hub rejected the token. Check the hub credentials on the server.' : 'The hub needs a browser session for questionnaire answers. Set HUB_COOKIE, or ask the hub team to expose the questionnaire under /api/admin.');
  if (!res.ok) throw new Error(`Hub responded ${res.status} for ${p}`);
  const ct = res.headers.get('content-type') || '';
  if (!/json/i.test(ct)) throw new Error(`Hub returned ${ct.split(';')[0] || 'a non-JSON response'} for ${p}. The token may not be valid without a browser session.`);
  return res.json();
}

// exposed for tests only
export const _hubInternal = { getToken: (...a) => getToken(...a), peek: () => cache && ({ exp: cache.exp, hasRefresh: !!cache.refreshToken, via: (() => { try { return JSON.parse(Buffer.from(cache.token.split('.')[1], 'base64url').toString()).via || 'login'; } catch { return '?'; } })() }), breakRefresh: () => { if (cache) cache.refreshToken = 'consumed-elsewhere'; } };

const isoDate = s => { const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0, 10); };

// Turn the hub's questionnaire answers into handbook/report fields plus a brief for the promo manager
export function normaliseQuestionnaire(doc, pressShots = []) {
  const data = doc?.data || doc || {};
  const a = {};
  for (const q of data.questionnaire || []) a[q.alias] = typeof q.answer === 'string' ? q.answer.trim() : q.answer;
  const socials = { instagram: a['instagram-link'] || '', tiktok: a['tiktok-link'] || '', facebook: a['facebook-link'] || '', twitter: a['twitter-link'] || '' };
  const platforms = ['ig'].concat(socials.tiktok ? ['tt'] : []);
  return {
    hubCampaignId: data.id,
    campaignTypeId: data.campaign_type_id,
    artistName: a['artist-name'] || '',
    artistType: a['artist-type'] || '',
    releaseTitle: a['release-name'] || '',
    releaseType: a['release-type'] || '',
    releaseDate: isoDate(a['release-date']),
    genre: a['release-genre'] || '',
    releaseLink: a['release-link'] || '',
    smartLink: /ditto\.fm|ffm\.to|feature\.fm/.test(a['release-link'] || '') ? a['release-link'] : '',
    campaignStart: isoDate(a['start-date']),
    contact: { name: a['contact-name'] || '', email: a['contact-email'] || '' },
    socials, platforms,
    pressShots: (Array.isArray(pressShots) ? pressShots : []).filter(u => typeof u === 'string'),
    brief: {
      about: a['release-information'] || '', biography: a['artist-biography'] || '', influences: a['artist-influences'] || '',
      comparisons: a['artist-comparisons'] || '', events: a['artist-events'] || '', contributors: a['release-contributors'] || '',
      lyrics: a['release-lyrics'] || '', assetLinks: a['asset-links'] || '', musicVideo: a['music-video-link'] || '', additional: a['additional-questions'] || ''
    }
  };
}

const STATUS_NAMES = { 1: 'Not started', 2: 'Questionnaire submitted' };
export function normaliseCampaign(c) {
  return {
    id: c.id,
    package: c.campaign_type?.name || (c.campaign_type_id === 3 ? 'Promo' : String(c.campaign_type_id || '')),
    customer: [c.customer?.forename, c.customer?.surname].filter(Boolean).join(' ').trim(),
    email: c.customer?.email_address || '',
    status: c.user_campaign_status?.name || STATUS_NAMES[c.user_campaign_status_id] || '',
    statusId: c.user_campaign_status_id,
    submitted: c.questionnaire_submission_date || null,
    startDate: c.start_date ? isoDate(c.start_date) : '',
    purchased: c.order?.created ? isoDate(c.order.created) : ''
  };
}

export function registerHubRoutes(app, { USE_R2, UPLOADS_DIR, r2Put }) {
  app.get('/api/hub/status', (req, res) => res.json({ configured: hubConfigured(), auth: hubAuthMode(), sessionBridge: !!COOKIE, base: HUB_BASE }));

  // Campaign list, newest questionnaire submissions first
  app.get('/api/hub/campaigns', async (req, res) => {
    if (!hubConfigured()) return res.status(503).json({ error: 'Hub import is not set up. Add HUB_AUTH_EMAIL and HUB_AUTH_PASSWORD (or HUB_API_TOKEN) to the environment.' });
    try {
      // Token-authenticated admin API, one list per status; fall back to the web route if it isn't there
      const statuses = ['incoming', 'social', 'press'];
      let list = [];
      try {
        const results = await Promise.all(statuses.map(st => hubGet(`/api/admin/campaigns/${st}`).catch(() => null)));
        for (const raw of results) { if (!raw) continue; const arr = Array.isArray(raw) ? raw : (raw.data || raw.campaigns || []); list.push(...arr); }
        if (!list.length) throw new Error('empty');
      } catch {
        const raw = await hubGet('/campaigns');
        list = Array.isArray(raw) ? raw : (raw.data || raw.campaigns || []);
      }
      list = list.filter((c, i, a) => a.findIndex(x => x.id === c.id) === i);
      const q = String(req.query.q || '').toLowerCase();
      const rows = list.map(normaliseCampaign)
        .filter(c => !q || c.customer.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || String(c.id) === q)
        .sort((x, y) => (y.submitted || '').localeCompare(x.submitted || '') || (y.purchased || '').localeCompare(x.purchased || ''));
      res.json({ count: rows.length, campaigns: rows.slice(0, 200) });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // One questionnaire, normalised, with press-shot links
  app.get('/api/hub/campaigns/:id/questionnaire', async (req, res) => {
    if (!hubConfigured()) return res.status(503).json({ error: 'Hub import is not set up. Add HUB_AUTH_EMAIL and HUB_AUTH_PASSWORD (or HUB_API_TOKEN) to the environment.' });
    const id = String(req.params.id).replace(/\D/g, '');
    if (!id) return res.status(400).json({ error: 'Campaign id must be a number' });
    try {
      const qPath = async () => { try { return await hubGet(`/api/admin/campaign/${id}/questionnaire`); } catch { return hubGet(`/questionnaire/${id}`); } };
      const sPath = async () => { try { return await hubGet(`/api/admin/campaign/${id}/press-shots`); } catch { return hubGet(`/questionnaire/${id}/press-shots`).catch(() => []); } };
      const [doc, shots] = await Promise.all([qPath(), sPath()]);
      res.json(normaliseQuestionnaire(doc, shots));
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // Copy a press shot into our own storage (the hub's links are signed and expire in minutes)
  app.post('/api/hub/campaigns/:id/press-shot', async (req, res) => {
    if (!hubConfigured()) return res.status(503).json({ error: 'Hub import is not set up.' });
    const id = String(req.params.id).replace(/\D/g, '');
    const { url } = req.body || {};
    try {
      let src = url;
      if (!src) { const shots = await hubGet(`/api/admin/campaign/${id}/press-shots`).catch(() => hubGet(`/questionnaire/${id}/press-shots`)); src = Array.isArray(shots) ? shots[0] : null; }
      const allowed = /^https:\/\/[a-z0-9.-]*amazonaws\.com\//i.test(src || '') || (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+\//.test(src || ''));
      if (!src || !allowed) return res.status(400).json({ error: 'No press shot on this questionnaire' });
      const r = await fetch(src);
      if (!r.ok) throw new Error(`Press shot download failed (${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) throw new Error('Press shot is over 15MB');
      const ct = r.headers.get('content-type') || 'image/jpeg';
      const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
      const filename = `${uuidv4()}-hub-${id}-press.${ext}`;
      if (USE_R2) await r2Put(`uploads/${filename}`, buf, ct); else fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
      res.json({ url: `/uploads/${filename}` });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });
}
