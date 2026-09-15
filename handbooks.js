/**
 * Social Handbook: storage, public client API, calendar feeds and staff API.
 *
 * Documents (JSON) live next to reports, in R2 or the local data dir:
 *   handbooks/<id>.json            one per handbook
 *   handbook-config/library.json   the shared idea bank   (seeded from seed/handbook-library.json)
 *   handbook-config/modules.json   the guide modules      (seeded from seed/handbook-modules.json)
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createHandbookStore({ USE_R2, DATA_DIR, r2Get, r2Put, r2Delete, r2List }) {
  const localPath = key => path.join(DATA_DIR, key);
  async function get(key) {
    if (USE_R2) { const r = await r2Get(key); return r ? JSON.parse(r.body.toString('utf-8')) : null; }
    const p = localPath(key);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
  }
  async function put(key, obj) {
    const json = JSON.stringify(obj, null, 2);
    if (USE_R2) return r2Put(key, json, 'application/json');
    const p = localPath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, json);
  }
  async function del(key) {
    if (USE_R2) return r2Delete(key);
    const p = localPath(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  async function list(prefix) {
    if (USE_R2) return (await r2List(prefix)).filter(k => k.endsWith('.json'));
    const dir = localPath(prefix);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => prefix + f);
  }
  const seed = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', name), 'utf-8'));
  async function config(name) {
    const key = `handbook-config/${name}.json`;
    let doc = await get(key);
    if (!doc) { doc = seed(`handbook-${name}.json`); await put(key, doc); return doc; }
    // Non-destructive top-up: any seed entry the stored document doesn't know about is added,
    // so new stock ideas/modules reach existing deployments without touching the team's edits.
    const seeded = seed(`handbook-${name}.json`);
    const listKey = name === 'library' ? 'ideas' : 'modules';
    const have = new Set((doc[listKey] || []).map(x => x.id));
    const missing = (seeded[listKey] || []).filter(x => !have.has(x.id) && !(doc.retired || []).includes(x.id));
    if (missing.length) { doc[listKey] = [...(doc[listKey] || []), ...missing]; doc.updatedAt = new Date().toISOString(); await put(key, doc); }
    return doc;
  }
  return { get, put, del, list, config, seed };
}

// ---------- helpers ----------
const ID_RE = /^[a-f0-9]{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidId = id => ID_RE.test(String(id || ''));
const newId = () => crypto.randomBytes(4).toString('hex');
const clean = (v, max = 400) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max).trim();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
const prettyDate = iso => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

function fillTokens(text, hb) {
  const rel = hb.releaseTitle ? `‘${hb.releaseTitle}’` : 'your release';
  return String(text || '')
    .replace(/\{release\}/g, rel)
    .replace(/\{artist\}/g, hb.artistName || 'you')
    .replace(/\{genre\}/g, hb.genre || 'your genre')
    .replace(/\{weeks\}/g, String(hb.weeks || 4))
    .replace(/\{year\}/g, String(new Date().getFullYear()));
}

// Effective date of a post: the artist's move wins over the team's recommendation
const postDate = (hb, p) => (hb.client?.moved?.[p.id]) || p.date;

// Sanitise a staff-supplied handbook body into the stored shape
function normaliseHandbook(input, existing = {}) {
  const hb = { ...existing };
  const s = (k, max) => { if (input[k] !== undefined) hb[k] = clean(input[k], max); };
  ['artistName', 'releaseTitle', 'genre', 'smartLink', 'artwork', 'pressShot', 'promoManager'].forEach(k => s(k, 500));
  ['releaseDate', 'campaignStart', 'campaignEnd'].forEach(k => { if (input[k] !== undefined) hb[k] = DATE_RE.test(input[k]) ? input[k] : ''; });
  if (input.weeks !== undefined) hb.weeks = Number(input.weeks) === 6 ? 6 : 4;
  if (input.package !== undefined) hb.package = input.package === 'plus' ? 'plus' : 'promo';
  if (input.heroMode !== undefined) hb.heroMode = ['auto', 'background', 'artwork', 'press'].includes(input.heroMode) ? input.heroMode : 'auto';
  if (input.platforms !== undefined) hb.platforms = [...new Set((input.platforms || []).filter(p => p === 'ig' || p === 'tt'))];
  if (input.intro !== undefined) hb.intro = clean(input.intro, 1000);
  if (input.hubCampaignId !== undefined) hb.hubCampaignId = String(input.hubCampaignId || '').replace(/\D/g, '') || null;
  if (input.brief && typeof input.brief === 'object') {
    hb.brief = Object.fromEntries(['about', 'biography', 'influences', 'comparisons', 'events', 'contributors', 'lyrics', 'assetLinks', 'musicVideo', 'additional'].map(k => [k, clean(input.brief[k], 4000)]));
  }
  if (input.socials && typeof input.socials === 'object') {
    hb.socials = Object.fromEntries(['instagram', 'tiktok', 'facebook', 'twitter'].map(k => [k, clean(input.socials[k], 300)]));
  }
  if (input.contact && typeof input.contact === 'object') hb.contact = { name: clean(input.contact.name, 120), email: clean(input.contact.email, 200) };
  if (Array.isArray(input.posts)) {
    hb.posts = input.posts.slice(0, 200).map(p => ({
      id: /^[a-z0-9-]{1,40}$/i.test(p.id || '') ? p.id : newId(),
      date: DATE_RE.test(p.date || '') ? p.date : hb.campaignStart,
      title: clean(p.title, 120),
      body: clean(p.body, 2000),
      format: ['Feed', 'Carousel', 'Reel', 'Story', 'Live'].includes(p.format) ? p.format : 'Feed',
      platforms: [...new Set((p.platforms || []).filter(x => x === 'ig' || x === 'tt'))].length ? [...new Set((p.platforms || []).filter(x => x === 'ig' || x === 'tt'))] : ['ig'],
      sourceIdeaId: clean(p.sourceIdeaId, 60) || null,
      release: !!p.release
    })).filter(p => p.title);
  }
  if (Array.isArray(input.modules)) {
    hb.modules = input.modules.slice(0, 40).map(m => ({ id: clean(m.id, 40), on: m.on !== false, html: m.html ? String(m.html).slice(0, 20000) : undefined }));
  }
  if (!hb.campaignEnd && hb.campaignStart) hb.campaignEnd = addDays(hb.campaignStart, (hb.weeks || 4) * 7 - 1);
  return hb;
}

// Resolve what the client page needs: the plan with effective dates + the enabled modules
function publicView(hb, modulesConfig) {
  const enabled = (hb.modules && hb.modules.length ? hb.modules : modulesConfig.modules.map(m => ({ id: m.id, on: m.default !== false })))
    .filter(m => m.on !== false)
    .map(m => { const base = modulesConfig.modules.find(x => x.id === m.id); if (!base) return null; return { id: base.id, eyebrow: base.eyebrow, title: base.title, platforms: base.platforms, html: fillTokens(m.html || base.html, hb).replace(/\{intro\}/g, fillTokens(hb.intro || modulesConfig.intro, hb)) }; })
    .filter(Boolean);
  return {
    id: hb.id, status: hb.status, updatedAt: hb.updatedAt, sentAt: hb.sentAt,
    artistName: hb.artistName, releaseTitle: hb.releaseTitle, releaseDate: hb.releaseDate, genre: hb.genre,
    smartLink: hb.smartLink, artwork: hb.artwork, pressShot: hb.pressShot, heroMode: hb.heroMode || 'auto',
    campaignStart: hb.campaignStart, campaignEnd: hb.campaignEnd, weeks: hb.weeks, package: hb.package, platforms: hb.platforms,
    promoManager: hb.promoManager || '',
    posts: (hb.posts || []).map(p => ({ ...p, body: fillTokens(p.body, hb), title: fillTokens(p.title, hb), recommendedDate: p.date, date: postDate(hb, p) })),
    modules: enabled,
    client: { done: hb.client?.done || {}, moved: hb.client?.moved || {}, subscribedAt: hb.client?.subscribedAt || null }
  };
}

// ---------- iCalendar ----------
const icsEscape = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsFold = line => { const out = []; let s = line; while (s.length > 72) { out.push(s.slice(0, 72)); s = ' ' + s.slice(72); } out.push(s); return out.join('\r\n'); };
function icsEvent(hb, p, baseUrl) {
  const d = postDate(hb, p).replace(/-/g, '');
  const plat = (p.platforms || []).map(x => x === 'ig' ? 'Instagram' : 'TikTok').join(' + ');
  const desc = `${fillTokens(p.body, hb)}\n\nFormat: ${p.format}${plat ? ' · ' + plat : ''}\nYour handbook: ${baseUrl}/handbook/${hb.id}`;
  return [
    'BEGIN:VEVENT',
    `UID:${hb.id}-${p.id}@promo.dittomusic.com`,
    `DTSTAMP:${new Date(hb.updatedAt || hb.createdAt || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`,
    `DTSTART:${d}T100000`,
    `DTEND:${d}T103000`,
    icsFold(`SUMMARY:${icsEscape((p.release ? '🎉 ' : '') + fillTokens(p.title, hb) + (plat ? ' (' + plat + ')' : ''))}`),
    icsFold(`DESCRIPTION:${icsEscape(desc)}`),
    icsFold(`URL:${baseUrl}/handbook/${hb.id}`),
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape('Time to post: ' + fillTokens(p.title, hb))}`, 'TRIGGER:-PT0M', 'END:VALARM',
    'END:VEVENT'
  ].join('\r\n');
}
function icsCalendar(hb, posts, baseUrl) {
  const name = `${hb.artistName || 'Your'} – Social Handbook`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ditto Promo//Social Handbook//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    icsFold(`X-WR-CALNAME:${icsEscape(name)}`), 'X-WR-TIMEZONE:Europe/London', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ...posts.map(p => icsEvent(hb, p, baseUrl)),
    'END:VCALENDAR', ''
  ].join('\r\n');
}

function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

// ---------- routes ----------
export function registerPublicHandbookRoutes(app, { store, publicDir, clientLimiter }) {
  const load = async (id) => isValidId(id) ? store.get(`handbooks/${id}.json`) : null;

  app.get('/handbook/:id', (req, res) => res.sendFile(path.join(publicDir, 'handbook.html')));

  app.get('/api/handbooks/:id/public', async (req, res) => {
    try {
      const hb = await load(req.params.id);
      if (!hb) return res.status(404).json({ error: 'Handbook not found' });
      res.json(publicView(hb, await store.config('modules')));
    } catch (err) { console.error('Handbook public read failed:', err); res.status(500).json({ error: 'Could not load handbook' }); }
  });

  // Client actions: tick off, move, subscribe, open. Public by design (the link is the key), but narrow.
  app.post('/api/handbooks/:id/client', clientLimiter, async (req, res) => {
    try {
      const hb = await load(req.params.id);
      if (!hb) return res.status(404).json({ error: 'Handbook not found' });
      const { action, postId, date } = req.body || {};
      hb.client = hb.client || { done: {}, moved: {}, activity: [] };
      hb.client.activity = hb.client.activity || [];
      const post = (hb.posts || []).find(p => p.id === postId);
      const log = entry => { hb.client.activity.unshift({ at: new Date().toISOString(), ...entry }); hb.client.activity = hb.client.activity.slice(0, 200); };
      if (action === 'done' || action === 'undone') {
        if (!post) return res.status(400).json({ error: 'Unknown post' });
        if (action === 'done') hb.client.done[postId] = new Date().toISOString(); else delete hb.client.done[postId];
        log({ type: action, postId, title: post.title });
      } else if (action === 'move') {
        if (!post) return res.status(400).json({ error: 'Unknown post' });
        if (!DATE_RE.test(date || '') || date < hb.campaignStart || date > hb.campaignEnd) return res.status(400).json({ error: 'Pick a date inside the campaign' });
        const from = postDate(hb, post);
        if (date === post.date) delete hb.client.moved[postId]; else hb.client.moved[postId] = date;
        log({ type: 'move', postId, title: post.title, from, to: date });
      } else if (action === 'subscribe') {
        hb.client.subscribedAt = hb.client.subscribedAt || new Date().toISOString();
        log({ type: 'subscribe' });
      } else if (action === 'open') {
        const last = hb.client.lastOpenedAt ? Date.parse(hb.client.lastOpenedAt) : 0;
        hb.client.lastOpenedAt = new Date().toISOString();
        hb.client.opens = (hb.client.opens || 0) + 1;
        if (Date.now() - last > 6 * 3600e3) log({ type: 'open', ua: clean(req.headers['user-agent'], 120) });
      } else return res.status(400).json({ error: 'Unknown action' });
      hb.clientUpdatedAt = new Date().toISOString();
      await store.put(`handbooks/${hb.id}.json`, hb);
      res.json({ done: hb.client.done, moved: hb.client.moved, subscribedAt: hb.client.subscribedAt || null });
    } catch (err) { console.error('Handbook client action failed:', err); res.status(500).json({ error: 'Could not save' }); }
  });

  // Calendar feeds. The whole plan is a subscribable feed; each post is also a one-off file.
  app.get('/handbook/:id/calendar.ics', async (req, res) => {
    const hb = await load(req.params.id);
    if (!hb) return res.status(404).send('Not found');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="${(hb.artistName || 'handbook').replace(/[^a-z0-9]+/gi, '-')}-social-handbook.ics"`);
    res.set('Cache-Control', 'no-cache');
    res.send(icsCalendar(hb, hb.posts || [], baseUrlOf(req)));
  });
  app.get('/handbook/:id/post/:postId.ics', async (req, res) => {
    const hb = await load(req.params.id);
    const post = hb && (hb.posts || []).find(p => p.id === req.params.postId);
    if (!post) return res.status(404).send('Not found');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${post.title.replace(/[^a-z0-9]+/gi, '-')}.ics"`);
    res.send(icsCalendar(hb, [post], baseUrlOf(req)));
  });
}

export function registerStaffHandbookRoutes(app, { store, publicDir }) {
  app.get('/handbooks', (req, res) => res.sendFile(path.join(publicDir, 'handbooks.html')));
  app.get('/handbooks/new', (req, res) => res.sendFile(path.join(publicDir, 'handbook-builder.html')));
  app.get('/handbooks/:id', (req, res) => res.sendFile(path.join(publicDir, 'handbook-builder.html')));

  app.get('/api/handbooks', async (req, res) => {
    try {
      const keys = await store.list('handbooks/');
      const docs = (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean);
      const q = String(req.query.q || '').toLowerCase();
      const rows = docs.map(h => ({
        id: h.id, artistName: h.artistName || '', releaseTitle: h.releaseTitle || '', status: h.status || 'draft',
        campaignStart: h.campaignStart, campaignEnd: h.campaignEnd, weeks: h.weeks, posts: (h.posts || []).length,
        done: Object.keys(h.client?.done || {}).length, opens: h.client?.opens || 0, lastOpenedAt: h.client?.lastOpenedAt || null,
        createdAt: h.createdAt, updatedAt: h.updatedAt, hero: h.pressShot || h.artwork || ''
      })).filter(r => !q || r.artistName.toLowerCase().includes(q) || r.releaseTitle.toLowerCase().includes(q));
      rows.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      res.json(rows);
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  app.get('/api/handbooks/:id', async (req, res) => {
    const hb = isValidId(req.params.id) ? await store.get(`handbooks/${req.params.id}.json`) : null;
    if (!hb) return res.status(404).json({ error: 'Handbook not found' });
    res.json(hb);
  });

  app.post('/api/handbooks', async (req, res) => {
    try {
      const id = newId();
      const hb = normaliseHandbook(req.body || {}, { id, version: 1, status: 'draft', createdAt: new Date().toISOString(), client: { done: {}, moved: {}, activity: [] } });
      hb.updatedAt = hb.createdAt;
      await store.put(`handbooks/${id}.json`, hb);
      res.json({ id, url: `/handbook/${id}` });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  app.put('/api/handbooks/:id', async (req, res) => {
    try {
      const existing = isValidId(req.params.id) ? await store.get(`handbooks/${req.params.id}.json`) : null;
      if (!existing) return res.status(404).json({ error: 'Handbook not found' });
      const hb = normaliseHandbook(req.body || {}, existing);
      hb.id = existing.id; hb.createdAt = existing.createdAt; hb.client = existing.client; hb.status = existing.status; hb.sentAt = existing.sentAt;
      hb.updatedAt = new Date().toISOString();
      await store.put(`handbooks/${hb.id}.json`, hb);
      res.json({ id: hb.id, url: `/handbook/${hb.id}`, updatedAt: hb.updatedAt });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  app.post('/api/handbooks/:id/send', async (req, res) => {
    const hb = isValidId(req.params.id) ? await store.get(`handbooks/${req.params.id}.json`) : null;
    if (!hb) return res.status(404).json({ error: 'Handbook not found' });
    hb.status = 'sent'; hb.sentAt = hb.sentAt || new Date().toISOString(); hb.updatedAt = new Date().toISOString();
    await store.put(`handbooks/${hb.id}.json`, hb);
    res.json({ id: hb.id, status: hb.status, sentAt: hb.sentAt, url: `/handbook/${hb.id}` });
  });

  app.delete('/api/handbooks/:id', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    await store.del(`handbooks/${req.params.id}.json`);
    res.json({ success: true });
  });

  // Shared config: idea library and guide modules
  for (const name of ['library', 'modules']) {
    app.get(`/api/handbook-config/${name}`, async (req, res) => {
      try { res.json(await store.config(name)); } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.put(`/api/handbook-config/${name}`, async (req, res) => {
      try {
        const doc = req.body;
        if (!doc || typeof doc !== 'object') return res.status(400).json({ error: 'Invalid document' });
        doc.updatedAt = new Date().toISOString();
        await store.put(`handbook-config/${name}.json`, doc);
        res.json({ success: true, updatedAt: doc.updatedAt });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.post(`/api/handbook-config/${name}/reset`, async (req, res) => {
      try { const doc = store.seed(`handbook-${name}.json`); await store.put(`handbook-config/${name}.json`, doc); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
    });
  }
}

export const _internal = { fillTokens, normaliseHandbook, publicView, icsCalendar, addDays, prettyDate };
