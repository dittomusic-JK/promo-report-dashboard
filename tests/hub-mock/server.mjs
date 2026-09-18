// Tiny stand-in for promo.dittomusic.com so the hub import can be exercised locally.
// Run: node tests/hub-mock/server.mjs   then start the app with HUB_BASE_URL=http://localhost:8790 HUB_API_TOKEN=test
import http from 'http';
import fs from 'fs';
import path from 'path';
const img = fs.readFileSync(path.resolve('public/assets/handbook/example-press-shot.jpg'));
const campaigns = [
  { id: 228, campaign_type: { id: 3, name: 'Promo' }, campaign_type_id: 3, customer: { forename: 'Vanessa', surname: 'Forero', email_address: 'vanessa@example.com' }, order: { created: '2026-08-30 10:00:00' }, questionnaire_submission_date: '2026-09-01', start_date: '2026-09-14', user_campaign_status: { id: 2, name: 'Questionnaire submitted' }, user_campaign_status_id: 2 },
  { id: 229, campaign_type: { id: 3, name: 'Promo' }, campaign_type_id: 3, customer: { forename: 'Monica', surname: 'Lynn', email_address: 'monica@example.com' }, order: { created: '2026-09-02 10:00:00' }, questionnaire_submission_date: null, start_date: null, user_campaign_status: { id: 1, name: 'Not started' }, user_campaign_status_id: 1 }
];
const q = { data: { id: 228, campaign_type_id: 3, questionnaire: [
  { alias: 'contact-name', answer: 'Vanessa' }, { alias: 'contact-email', answer: 'vanessa@example.com' }, { alias: 'start-date', answer: '2026-09-14 09:00:00' },
  { alias: 'release-type', answer: 'Single' }, { alias: 'release-link', answer: 'https://ditto.fm/days-before' }, { alias: 'release-name', answer: 'Days Before' },
  { alias: 'release-genre', answer: 'Soul' }, { alias: 'release-date', answer: '2026-09-25 00:00:00' }, { alias: 'release-contributors', answer: 'Produced by J. Smith' },
  { alias: 'release-information', answer: 'A song about the days before a big change. Written in Yorkshire, recorded in a mega church.' },
  { alias: 'artist-name', answer: 'Vanessa Forero' }, { alias: 'artist-biography', answer: 'Soul singer-songwriter from Yorkshire.' }, { alias: 'artist-influences', answer: 'Amy Winehouse, Lianne La Havas' },
  { alias: 'artist-events', answer: 'Leeds Brudenell 3 Oct, Manchester Deaf Institute 10 Oct' }, { alias: 'artist-comparisons', answer: 'Celeste, Jorja Smith' },
  { alias: 'instagram-link', answer: 'https://instagram.com/vanessaforero' }, { alias: 'tiktok-link', answer: 'https://tiktok.com/@vanessaforero' }, { alias: 'facebook-link', answer: '' }, { alias: 'twitter-link', answer: '' },
  { alias: 'music-video-link', answer: 'https://youtube.com/watch?v=abc' }, { alias: 'press-shots', answer: 'press.jpg' }, { alias: 'release-lyrics', answer: 'In the days before...' }, { alias: 'artist-type', answer: 'Solo artist' }
] } };
http.createServer((req, res) => {
  if (req.url.startsWith('/s3/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(img); } // signed S3 links need no token
  if (req.url === '/authentication_token' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { email, password } = JSON.parse(body || '{}');
      if (email !== 'svc@example.com' || password !== 'pw') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"Invalid credentials."}'); }
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 31 * 86400, username: email, roles: ['ROLE_ADMIN'] })).toString('base64url');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ token: `mock.${payload}.sig` }));
    }); return;
  }
  const auth = req.headers.authorization || '';
  if (!/^Bearer (test|mock\.[A-Za-z0-9_-]+\.sig)$/.test(auth)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"Unauthenticated."}'); }
  const json = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/campaigns') return json({ data: campaigns });
  if (req.url === '/api/admin/campaigns/incoming') return json(campaigns.filter(c => c.user_campaign_status_id < 3));
  if (req.url === '/api/admin/campaigns/social' || req.url === '/api/admin/campaigns/press') return json([]);
  if (req.url === '/questionnaire/228') return json(q);
  if (req.url === '/questionnaire/228/press-shots') return json(['http://localhost:8790/s3/campaigns/228/user-assets/press.jpg?X-Amz-Signature=fake']);
  if (req.url.startsWith('/s3/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(img); }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"Not found"}');
}).listen(8790, () => console.log('hub mock on 8790'));
