import express from 'express';
import { chromium } from 'playwright';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// Use persistent disk on Render, local folders in dev
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/data' : __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

// Password protection
const PASSWORD = 'PromoReport2026';
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  // Sessions expire after 24 hours
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Cookie parser middleware
function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      cookies[name] = value;
    });
  }
  return cookies;
}

// Auth middleware
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (isValidSession(cookies.session)) {
    return next();
  }
  // For API routes, return 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // For page routes, redirect to login
  res.redirect('/login');
}

// Setup
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files for login page (public access)
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// Login routes (public)
app.get('/login', (req, res) => {
  const cookies = parseCookies(req);
  if (isValidSession(cookies.session)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    const token = createSession();
    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${24 * 60 * 60}`);
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session) {
    sessions.delete(cookies.session);
  }
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

// Protected routes
app.use(requireAuth);

// Static files (protected)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/reports', express.static(REPORTS_DIR));

// Ensure directories exist
[UPLOADS_DIR, REPORTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Store reports in memory (in production, use a database)
const reports = new Map();

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/create', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create.html'));
});

app.get('/library', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'library.html'));
});

// Upload image endpoint
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// Scrape smart link for artwork
app.post('/api/scrape-smartlink', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  console.log(`Scraping smart link: ${url}`);
  
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1200, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    const page = await context.newPage();
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    const data = await page.evaluate(() => {
      const result = { artwork: '', title: '', artist: '' };
      
      // FFM smart links use CSS background-image for artwork
      // First try the specific player background element (has clean square artwork)
      const playerBg = document.querySelector('.song-player-bg, .player-content, [class*="player"][style*="background"]');
      if (playerBg) {
        const style = playerBg.getAttribute('style') || '';
        const match = style.match(/url\(["']?([^"')]+)["']?\)/);
        if (match && match[1].includes('imagestore.ffm.to') && !match[1].includes('e_blur')) {
          result.artwork = match[1];
        }
      }
      
      // Look for elements with background-image containing imagestore.ffm.to
      // Prefer non-blurred images
      if (!result.artwork) {
        const allBgImages = [];
        const allElements = document.querySelectorAll('[style*="background"]');
        for (const el of allElements) {
          const style = el.getAttribute('style') || '';
          if (style.includes('imagestore.ffm.to')) {
            const match = style.match(/url\(["']?([^"')]+)["']?\)/);
            if (match) {
              allBgImages.push(match[1]);
            }
          }
        }
        
        // Prefer non-blurred image
        const cleanArtwork = allBgImages.find(url => !url.includes('e_blur'));
        if (cleanArtwork) {
          result.artwork = cleanArtwork;
        } else if (allBgImages.length > 0) {
          result.artwork = allBgImages[0];
        }
      }
      
      // Last fallback: og:image (might be a banner, not square)
      if (!result.artwork) {
        const ogImage = document.querySelector('meta[property="og:image"]');
        if (ogImage) result.artwork = ogImage.getAttribute('content') || '';
      }
      
      // Get title and artist from og tags
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        const titleText = ogTitle.getAttribute('content') || '';
        const parts = titleText.split(' - ');
        if (parts.length >= 2) {
          result.title = parts[0].trim();
          result.artist = parts[1].trim();
        } else {
          result.title = titleText;
        }
      }
      
      return result;
    });
    
    // Generate blurred background URL from artwork if it's an FFM cloudinary image
    if (data.artwork && data.artwork.includes('cloudinary-cdn.ffm.to')) {
      // Extract the base image path and create a blurred version
      // Pattern: add blur transformation to cloudinary URL
      const artworkUrl = data.artwork;
      // Insert blur params into cloudinary URL
      if (artworkUrl.includes('/f_webp/') || artworkUrl.includes('/f_jpg/')) {
        data.artworkBlurred = artworkUrl.replace(
          /(cloudinary-cdn\.ffm\.to\/s--[^/]+--\/)/,
          '$1w_800,h_800,c_lfill/c_scale,fl_relative,w_1.1/e_blur:800/'
        );
      }
    }
    
    await browser.close();
    console.log('Scraped smart link:', data);
    res.json(data);
    
  } catch (error) {
    console.error('Smart link scrape error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Scrape PR article data
app.post('/api/scrape-article', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  console.log(`Scraping article: ${url}`);
  
  try {
    const data = await scrapeArticle(url);
    res.json(data);
  } catch (error) {
    console.error('Article scrape error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Scrape Spotify playlist data
app.post('/api/scrape-spotify-playlist', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  // Extract playlist ID from URL
  const playlistMatch = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (!playlistMatch) return res.status(400).json({ error: 'Invalid Spotify playlist URL' });
  
  const playlistId = playlistMatch[1];
  console.log(`Scraping Spotify playlist: ${playlistId}`);
  
  try {
    const data = await scrapeSpotifyPlaylist(url, playlistId);
    res.json(data);
  } catch (error) {
    console.error('Spotify scrape error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Scrape Feature.fm analytics
app.post('/api/scrape-ffm', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  console.log(`Scraping: ${url}`);
  
  try {
    const data = await scrapeFeatureFm(url);
    res.json(data);
  } catch (error) {
    console.error('Scrape error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create report
app.post('/api/reports', async (req, res) => {
  const reportId = uuidv4().slice(0, 8);
  const reportData = {
    id: reportId,
    createdAt: new Date().toISOString(),
    ...req.body
  };
  
  reports.set(reportId, reportData);
  
  // Save to file for persistence
  const reportPath = path.join(REPORTS_DIR, `${reportId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
  
  res.json({ id: reportId, url: `/report/${reportId}` });
});

// List all reports with optional search
app.get('/api/reports', (req, res) => {
  const { q } = req.query;
  
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json'));
    let reportsList = files.map(file => {
      const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, file), 'utf-8'));
      return {
        id: data.id,
        artistName: data.artistName || '',
        releaseTitle: data.releaseTitle || '',
        dateRange: data.dateRange || '',
        createdAt: data.createdAt || '',
        heroArtwork: data.heroArtwork || ''
      };
    });
    
    // Filter by search query if provided
    if (q) {
      const query = q.toLowerCase();
      reportsList = reportsList.filter(r => 
        r.artistName.toLowerCase().includes(query) ||
        r.releaseTitle.toLowerCase().includes(query)
      );
    }
    
    // Sort by createdAt descending (newest first)
    reportsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json(reportsList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get report
app.get('/api/reports/:id', (req, res) => {
  const { id } = req.params;
  
  // Try memory first
  if (reports.has(id)) {
    return res.json(reports.get(id));
  }
  
  // Try file
  const reportPath = path.join(REPORTS_DIR, `${id}.json`);
  if (fs.existsSync(reportPath)) {
    const data = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    reports.set(id, data);
    return res.json(data);
  }
  
  res.status(404).json({ error: 'Report not found' });
});

// Update report
app.put('/api/reports/:id', (req, res) => {
  const { id } = req.params;
  const reportPath = path.join(REPORTS_DIR, `${id}.json`);
  
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'Report not found' });
  }
  
  const existingData = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const updatedData = {
    ...existingData,
    ...req.body,
    id, // Preserve original ID
    createdAt: existingData.createdAt, // Preserve original creation date
    updatedAt: new Date().toISOString()
  };
  
  reports.set(id, updatedData);
  fs.writeFileSync(reportPath, JSON.stringify(updatedData, null, 2));
  
  res.json({ id, url: `/report/${id}` });
});

// Delete report
app.delete('/api/reports/:id', (req, res) => {
  const { id } = req.params;
  const reportPath = path.join(REPORTS_DIR, `${id}.json`);
  
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'Report not found' });
  }
  
  fs.unlinkSync(reportPath);
  reports.delete(id);
  
  res.json({ success: true });
});

// View report page
app.get('/report/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

// Feature.fm scraper function - captures full dashboard data
async function scrapeFeatureFm(url) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 2000 } });
  const page = await context.newPage();
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    
    // Auto-scroll to load ALL content
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 300);
          totalHeight += 300;
          if (totalHeight >= document.body.scrollHeight + 1000) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
      });
    });
    await page.waitForTimeout(3000);
    
    // Extract ALL Feature.fm data
    const data = await page.evaluate(() => {
      const result = {
        release: { title: '', link: '', artwork: '' },
        dateRange: '',
        overview: { totalVisits: 0, uniqueUsers: 0, clicksToService: 0 },
        channels: [],
        referrals: [],
        services: [],
        countries: []
      };
      
      // Get release info
      const linkEl = document.querySelector('a[href*="ditto.fm"]');
      if (linkEl) {
        result.release.link = linkEl.href || linkEl.textContent;
      }
      
      // Get artwork
      const artworkImg = document.querySelector('img[src*="artwork"], img[src*="cover"], img[alt*="artwork"]');
      if (artworkImg) {
        result.release.artwork = artworkImg.src;
      }
      
      // Get date range - look for the date picker text
      const dateElements = document.querySelectorAll('*');
      for (const el of dateElements) {
        const text = el.textContent?.trim() || '';
        const dateMatch = text.match(/([A-Z][a-z]{2} \d{1,2}, \d{4})\s*-\s*([A-Z][a-z]{2} \d{1,2}, \d{4})/);
        if (dateMatch && el.children.length < 3) {
          result.dateRange = dateMatch[0];
          break;
        }
      }
      
      // Get title from header area
      const headerText = document.body.innerText.substring(0, 500);
      const titleMatch = headerText.match(/^([\s\S]*?)https:\/\/ditto\.fm/);
      if (titleMatch) {
        result.release.title = titleMatch[1]
          .replace(/INSIGHTS|CONVERSION|favicon[^\s]*/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
      
      // ===== EXTRACT OVERVIEW METRICS =====
      // Find all large numbers near specific labels
      const allText = document.body.innerText;
      
      // Total Visits
      const visitsMatch = allText.match(/(\d+)\s*Total Visits/i) || 
                          allText.match(/(\d+)[\s\n]+Total Visits/i);
      if (visitsMatch) result.overview.totalVisits = parseInt(visitsMatch[1]);
      
      // Unique Users
      const usersMatch = allText.match(/(\d+)\s*Unique Users/i) ||
                         allText.match(/(\d+)[\s\n]+Unique Users/i);
      if (usersMatch) result.overview.uniqueUsers = parseInt(usersMatch[1]);
      
      // Clicks to Service  
      const clicksMatch = allText.match(/(\d+)\s*Clicks to Service/i) ||
                          allText.match(/(\d+)[\s\n]+Clicks to Service/i);
      if (clicksMatch) result.overview.clicksToService = parseInt(clicksMatch[1]);
      
      // ===== EXTRACT REFERRALS TABLE =====
      // Look for the REFERRALS section and parse each row
      const referralNames = ['direct', 'instagram.com', 'facebook.com', 'tiktok.com', 
                             'twitter.com', 'youtube.com', 'google.com', 'ditto.fm',
                             'dashboard.dittomusic.com', 'l.instagram.com', 't.co',
                             'linktr.ee', 'linkin.bio'];
      
      referralNames.forEach(name => {
        // Match pattern: referrer name followed by numbers
        const escapedName = name.replace(/\./g, '\\.');
        const regex = new RegExp(escapedName + '[\\s\\n]+(\\d+)[\\s\\n]*([\\d.]+%)?[\\s\\n]*(\\d+)?[\\s\\n]*([\\d.]+%)?[\\s\\n]*(\\d+)?', 'i');
        const match = allText.match(regex);
        
        if (match && parseInt(match[1]) > 0) {
          result.referrals.push({
            name: name,
            visits: parseInt(match[1]) || 0,
            visitsPercent: match[2] || '',
            songPreviews: parseInt(match[3]) || 0,
            clicksToService: parseInt(match[5]) || 0
          });
        }
      });
      
      // Sort referrals by visits
      result.referrals.sort((a, b) => b.visits - a.visits);
      
      // ===== EXTRACT SERVICES (CLICKS TO SERVICE) =====
      const servicePatterns = [
        { name: 'Spotify', icon: '🟢' },
        { name: 'Apple Music', icon: '🍎' },
        { name: 'YouTube Music', icon: '🔴' },
        { name: 'YouTube', icon: '▶️' },
        { name: 'Pandora', icon: '🎵' },
        { name: 'Deezer', icon: '💜' },
        { name: 'TIDAL', icon: '⬛' },
        { name: 'Amazon Music', icon: '📦' },
        { name: 'Amazon Music (Streaming)', icon: '📦' },
        { name: 'Boomplay', icon: '🔵' },
        { name: 'SoundCloud', icon: '☁️' },
        { name: 'Audiomack', icon: '🎧' }
      ];
      
      servicePatterns.forEach(({ name, icon }) => {
        const escapedName = name.replace(/[\(\)]/g, '\\$&');
        const regex = new RegExp(escapedName + '\\s*(\\d+)\\s*([\\d.]+%)?', 'i');
        const match = allText.match(regex);
        
        if (match && parseInt(match[1]) > 0) {
          // Avoid duplicates
          if (!result.services.find(s => s.name === name)) {
            result.services.push({
              name,
              icon,
              clicks: parseInt(match[1]),
              percentage: match[2] || ''
            });
          }
        }
      });
      
      result.services.sort((a, b) => b.clicks - a.clicks);
      
      // Calculate percentages if not present
      const totalClicks = result.services.reduce((sum, s) => sum + s.clicks, 0);
      result.services.forEach(s => {
        if (!s.percentage && totalClicks > 0) {
          s.percentage = ((s.clicks / totalClicks) * 100).toFixed(1) + '%';
        }
      });
      
      // ===== EXTRACT COUNTRIES =====
      const countryPatterns = [
        'United Kingdom', 'United States', 'Australia', 'Canada', 'Germany', 
        'France', 'Ireland', 'Netherlands', 'Brazil', 'Mexico', 'Spain', 'Italy',
        'India', 'Japan', 'South Africa', 'New Zealand', 'Sweden', 'Norway',
        'Denmark', 'Finland', 'Belgium', 'Austria', 'Switzerland', 'Poland', 'Portugal'
      ];
      
      countryPatterns.forEach(country => {
        // Match country followed by numbers (visits, song previews, clicks)
        const regex = new RegExp(country + '\\s*[^\\d]*(\\d+)\\s*([\\d.]+%)?', 'i');
        const match = allText.match(regex);
        
        if (match && parseInt(match[1]) > 0) {
          if (!result.countries.find(c => c.name === country)) {
            result.countries.push({
              name: country,
              visits: parseInt(match[1]),
              percentage: match[2] || ''
            });
          }
        }
      });
      
      result.countries.sort((a, b) => b.visits - a.visits);
      
      // Calculate country percentages
      const totalVisits = result.overview.totalVisits || result.countries.reduce((sum, c) => sum + c.visits, 0);
      result.countries.forEach(c => {
        if (!c.percentage && totalVisits > 0) {
          c.percentage = ((c.visits / totalVisits) * 100).toFixed(1) + '%';
        }
      });
      
      return result;
    });
    
    // Take full page screenshot
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const screenshotFilename = `ffm-${Date.now()}.png`;
    fs.writeFileSync(path.join(UPLOADS_DIR, screenshotFilename), screenshotBuffer);
    data.screenshot = `/uploads/${screenshotFilename}`;
    
    await browser.close();
    
    console.log('Scraped data:', JSON.stringify(data, null, 2));
    return data;
    
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Article scraper function for PR placements
async function scrapeArticle(url) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    // Extract domain for site name
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace('www.', '');
    
    const data = await page.evaluate((domain) => {
      const result = {
        siteName: '',
        title: '',
        excerpt: '',
        heroImage: '',
        logo: ''
      };
      
      // Get site name from meta or domain
      const ogSiteName = document.querySelector('meta[property="og:site_name"]');
      if (ogSiteName) {
        result.siteName = ogSiteName.getAttribute('content') || '';
      } else {
        // Use domain as fallback, capitalize first letter
        result.siteName = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
      }
      
      // Get article title
      const ogTitle = document.querySelector('meta[property="og:title"]');
      const h1 = document.querySelector('h1');
      const titleTag = document.querySelector('title');
      result.title = ogTitle?.getAttribute('content') || h1?.textContent?.trim() || titleTag?.textContent?.trim() || '';
      
      // Get excerpt/description
      const ogDesc = document.querySelector('meta[property="og:description"]');
      const metaDesc = document.querySelector('meta[name="description"]');
      result.excerpt = ogDesc?.getAttribute('content') || metaDesc?.getAttribute('content') || '';
      
      // If no meta description, try to get first paragraph
      if (!result.excerpt) {
        const paragraphs = document.querySelectorAll('article p, .content p, .post p, main p');
        for (const p of paragraphs) {
          const text = p.textContent?.trim() || '';
          if (text.length > 50) {
            result.excerpt = text.substring(0, 200) + (text.length > 200 ? '...' : '');
            break;
          }
        }
      }
      
      // Get hero/featured image
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) {
        result.heroImage = ogImage.getAttribute('content') || '';
      } else {
        // Try to find main article image
        const articleImg = document.querySelector('article img, .featured-image img, .post-thumbnail img, .hero img, main img');
        if (articleImg) result.heroImage = articleImg.src;
      }
      
      // Get site logo
      // Try common logo selectors
      const logoSelectors = [
        'link[rel="icon"][sizes="192x192"]',
        'link[rel="apple-touch-icon"]',
        'link[rel="icon"][type="image/png"]',
        'link[rel="shortcut icon"]',
        'link[rel="icon"]',
        '.logo img',
        '.site-logo img',
        'header img[alt*="logo" i]',
        'header img',
        'a[href="/"] img'
      ];
      
      for (const selector of logoSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const src = el.href || el.src || el.getAttribute('content');
          if (src) {
            result.logo = src;
            break;
          }
        }
      }
      
      return result;
    }, domain);
    
    // Make URLs absolute if needed
    if (data.heroImage && !data.heroImage.startsWith('http')) {
      data.heroImage = new URL(data.heroImage, url).href;
    }
    if (data.logo && !data.logo.startsWith('http')) {
      data.logo = new URL(data.logo, url).href;
    }
    
    // Take screenshot of the article for fallback
    const screenshotBuffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1400, height: 800 } });
    const screenshotFilename = `article-${Date.now()}.png`;
    fs.writeFileSync(path.join(UPLOADS_DIR, screenshotFilename), screenshotBuffer);
    data.screenshot = `/uploads/${screenshotFilename}`;
    
    await browser.close();
    
    data.articleUrl = url;
    console.log('Scraped article:', data);
    return data;
    
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Spotify playlist scraper function
async function scrapeSpotifyPlaylist(url, playlistId) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    // Debug: Log all images found
    const allImagesDebug = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img');
      return Array.from(imgs).map(img => ({
        src: img.src,
        srcset: img.srcset,
        alt: img.alt,
        width: img.width,
        height: img.height
      })).filter(i => i.src);
    });
    console.log('\n=== ALL IMAGES FOUND ===');
    allImagesDebug.forEach((img, i) => {
      console.log(`${i + 1}. ${img.src}`);
      if (img.srcset) console.log(`   srcset: ${img.srcset}`);
    });
    console.log('========================\n');
    
    const data = await page.evaluate(() => {
      const result = {
        name: '',
        curator: '',
        curatorAvatar: '',
        followers: '',
        coverImage: ''
      };
      
      // Get playlist name - try multiple selectors
      // Try the main content area h1 first, avoiding navigation elements
      const h1s = document.querySelectorAll('h1');
      for (const h1 of h1s) {
        const text = h1.textContent?.trim() || '';
        // Skip generic UI elements
        if (text && !text.includes('Your Library') && !text.includes('Home') && text.length > 0) {
          result.name = text;
          break;
        }
      }
      
      // Try data-testid for playlist title
      if (!result.name) {
        const titleEl = document.querySelector('[data-testid="entityTitle"] h1, [data-testid="playlist-title"]');
        if (titleEl) result.name = titleEl.textContent?.trim() || '';
      }
      
      // Get from page title as fallback
      if (!result.name) {
        const pageTitle = document.title;
        const match = pageTitle.match(/^(.+?)\s*[-–|]\s*playlist/i) || pageTitle.match(/^(.+?)\s*[-–|]\s*Spotify/i);
        if (match) result.name = match[1].trim();
      }
      
      // Get curator name - look for "by" text or owner link
      const ownerLink = document.querySelector('a[href*="/user/"]');
      if (ownerLink) result.curator = ownerLink.textContent?.trim() || '';
      
      // Get curator avatar - small circular image near the owner name
      const ownerSection = ownerLink?.closest('div');
      if (ownerSection) {
        const avatarImg = ownerSection.querySelector('img');
        if (avatarImg && avatarImg.src) {
          result.curatorAvatar = avatarImg.src;
        }
      }
      
      // Get follower/save count - look for text containing "likes" or "saves"
      const allText = document.body.innerText;
      const likesMatch = allText.match(/([\d,]+)\s*likes?/i) || 
                         allText.match(/([\d,]+)\s*saves?/i) ||
                         allText.match(/([\d,]+)\s*followers?/i);
      if (likesMatch) result.followers = likesMatch[1];
      
      // Get playlist cover image
      // First try og:image meta tag - most reliable for Spotify
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) {
        const ogSrc = ogImage.getAttribute('content') || '';
        // Make sure it's not a user avatar
        if (ogSrc && !ogSrc.includes('ab67757')) {
          result.coverImage = ogSrc;
        }
      }
      
      // Fallback to finding images in DOM
      // Spotify image URL patterns:
      // - ab67706c = playlist covers (what we want)
      // - ab67616d = album/track artwork  
      // - ab67757 = user profile images (skip these)
      // - mosaic = generated playlist covers from multiple tracks
      
      if (!result.coverImage) {
        const allImages = document.querySelectorAll('img[src*="scdn.co"], img[srcset*="scdn.co"], img[src*="spotifycdn.com"]');
        
        // First priority: image-cdn-ak.spotifycdn.com with ab67706c (playlist covers)
        for (const img of allImages) {
          const src = img.src || '';
          if (src.includes('image-cdn-ak.spotifycdn.com') && src.includes('ab67706c')) {
            result.coverImage = src;
            break;
          }
        }
        
        // Second priority: any ab67706c pattern (playlist covers)
        if (!result.coverImage) {
          for (const img of allImages) {
            const src = img.src || '';
            const srcset = img.srcset || '';
            
            const isPlaylistCover = src.includes('ab67706c') || srcset.includes('ab67706c') ||
                                    src.includes('mosaic') || srcset.includes('mosaic');
            const isUserAvatar = src.includes('ab67757') || srcset.includes('ab67757');
            
            if (isPlaylistCover && !isUserAvatar) {
              if (srcset) {
                const srcsetParts = srcset.split(',');
                const largest = srcsetParts[srcsetParts.length - 1]?.trim().split(' ')[0];
                result.coverImage = largest || src;
              } else {
                result.coverImage = src;
              }
              break;
            }
          }
        }
        
        // Third priority: any image-cdn that's not an avatar
        if (!result.coverImage) {
          for (const img of allImages) {
            const src = img.src || '';
            if (src.includes('image-cdn') && !src.includes('ab67757')) {
              result.coverImage = src;
              break;
            }
          }
        }
        
        // Final fallback: any large image that's not an avatar
        if (!result.coverImage) {
          for (const img of allImages) {
            const src = img.src || '';
            const width = img.width || img.naturalWidth || 0;
            if (width >= 100 && !src.includes('ab67757')) {
              result.coverImage = src;
              break;
            }
          }
        }
      }
      
      return result;
    });
    
    await browser.close();
    
    // Ensure we have the Spotify URL
    data.spotifyUrl = url;
    data.playlistId = playlistId;
    
    console.log('Scraped Spotify playlist:', data);
    return data;
    
  } catch (error) {
    await browser.close();
    throw error;
  }
}

app.listen(PORT, () => {
  console.log(`\n🚀 Ditto Promo Report Dashboard`);
  console.log(`   http://localhost:${PORT}\n`);
});
