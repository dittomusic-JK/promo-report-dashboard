// Checks whether a dashboard2 service account can read the Promo hub server-to-server.
// Prints status codes and response shapes only. Never prints credentials or the token.
// Run:  HUB_AUTH_EMAIL=... HUB_AUTH_PASSWORD=... node tests/hub-auth-check.mjs [campaignId]
//  or:  node tests/hub-auth-check.mjs [campaignId] path/to/.env   (reads HUB_AUTH_* or DITTO_TRENDS_* from that file)
import fs from 'fs';
let email = process.env.HUB_AUTH_EMAIL, password = process.env.HUB_AUTH_PASSWORD;
const envFile = process.argv[3];
if ((!email || !password) && envFile) {
  const vars = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(HUB_AUTH_EMAIL|HUB_AUTH_PASSWORD|DITTO_TRENDS_EMAIL|DITTO_TRENDS_PASSWORD)\s*=\s*(.*)$/);
    if (m) vars[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  email = email || vars.HUB_AUTH_EMAIL || vars.DITTO_TRENDS_EMAIL;
  password = password || vars.HUB_AUTH_PASSWORD || vars.DITTO_TRENDS_PASSWORD;
}
if (!email || !password) { console.error('Set HUB_AUTH_EMAIL and HUB_AUTH_PASSWORD, or pass an env file as the second argument'); process.exit(1); }
const AUTH_URL = process.env.HUB_AUTH_URL || 'https://dashboard2.dittomusic.com/authentication_token';
const BASE = (process.env.HUB_BASE_URL || 'https://promo.dittomusic.com').replace(/\/$/, '');
const id = process.argv[2] || '228';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const r = await fetch(AUTH_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify({ email, password }) });
console.log('login'.padEnd(44), r.status);
if (!r.ok) { console.log((await r.text()).slice(0, 160)); process.exit(0); }
const j = await r.json(); const token = j.token ?? j.access_token;
try { const c = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); console.log('token'.padEnd(44), `roles=${JSON.stringify(c.roles)} valid ${Math.round((c.exp - Date.now() / 1000) / 86400)} days`); } catch {}
const base = { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', 'user-agent': UA };
// Pass 1: the token as a bearer header. Pass 2: the token in Ditto's SSO cookie, which is how
// browser sessions on .dittomusic.com carry the dashboard2 JWT. Diagnostic only.
const passes = [['bearer header', { ...base, authorization: 'Bearer ' + token }], ['SSO cookie', { ...base, cookie: `DittoMusic[jwtprod]=${token}` }], ['both', { ...base, authorization: 'Bearer ' + token, cookie: `DittoMusic[jwtprod]=${token}` }]];
for (const [label, H] of passes) {
console.log(`\n-- ${label}`);
for (const p of ['/api/admin/campaigns/incoming', '/api/admin/campaigns/social', `/api/admin/campaign/${id}/questionnaire`, `/questionnaire/${id}`, `/questionnaire/${id}/press-shots`]) {
  const res = await fetch(BASE + p, { headers: H, redirect: 'manual' });
  const ct = (res.headers.get('content-type') || '').split(';')[0]; let shape = '';
  if (/json/.test(ct)) { const b = await res.json(); shape = Array.isArray(b) ? `array[${b.length}]` : ('keys: ' + Object.keys(b).slice(0, 5).join(',')) + (b.data?.questionnaire ? ` · questionnaire[${b.data.questionnaire.length}]` : '') + (b.message ? ` · ${b.message}` : ''); }
  console.log(p.padEnd(44), res.status, ct, shape);
}
}
