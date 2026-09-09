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
 * Env: HUB_API_TOKEN (required), HUB_COOKIE (optional, e.g. "laravel_session=..."),
 *      HUB_BASE_URL (default https://promo.dittomusic.com)
 */
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const HUB_BASE = (process.env.HUB_BASE_URL || 'https://promo.dittomusic.com').replace(/\/$/, '');
const TOKEN = process.env.HUB_API_TOKEN || '';
const COOKIE = process.env.HUB_COOKIE || '';
export const hubConfigured = () => !!TOKEN;

async function hubGet(p) {
  const headers = { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', authorization: `Bearer ${TOKEN}` };
  if (COOKIE) headers.cookie = COOKIE;
  const res = await fetch(`${HUB_BASE}${p}`, { headers, redirect: 'manual' });
  if (res.status === 401 || res.status === 419 || res.status === 302) throw new Error(p.startsWith('/api/') ? 'The hub rejected the token. HUB_API_TOKEN may have expired.' : 'The hub needs a browser session for questionnaire answers. Set HUB_COOKIE, or ask the hub team to expose the questionnaire under /api/admin.');
  if (!res.ok) throw new Error(`Hub responded ${res.status} for ${p}`);
  const ct = res.headers.get('content-type') || '';
  if (!/json/i.test(ct)) throw new Error(`Hub returned ${ct.split(';')[0] || 'a non-JSON response'} for ${p}. The token may not be valid without a browser session.`);
  return res.json();
}

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
  app.get('/api/hub/status', (req, res) => res.json({ configured: hubConfigured(), sessionBridge: !!COOKIE, base: HUB_BASE }));

  // Campaign list, newest questionnaire submissions first
  app.get('/api/hub/campaigns', async (req, res) => {
    if (!hubConfigured()) return res.status(503).json({ error: 'Hub import is not set up. Add HUB_API_TOKEN to the environment.' });
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
    if (!hubConfigured()) return res.status(503).json({ error: 'Hub import is not set up. Add HUB_API_TOKEN to the environment.' });
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
