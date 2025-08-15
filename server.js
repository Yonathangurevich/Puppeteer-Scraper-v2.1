const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const BlockResourcesPlugin = require('puppeteer-extra-plugin-block-resources');

// Use stealth plugin
puppeteer.use(StealthPlugin());

// Block unnecessary resources
puppeteer.use(BlockResourcesPlugin({
  blockedTypes: new Set(['image', 'stylesheet', 'font', 'media'])
}));

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Cache for sessions
const sessionCache = new Map();
const htmlCache = new Map(); // Cache לתוצאות
const CACHE_TTL = 5 * 60 * 1000; // 5 דקות

// Browser launch options
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-web-security',
  '--disable-gpu',
  '--no-first-run',
  '--window-size=1920,1080',
  '--single-process' // חשוב למהירות ב-Railway
];

async function fastCloudflareBypass(page, url, fullScrape = false) {
  console.log(`🚀 Starting ${fullScrape ? 'FULL SCRAPE' : 'URL ONLY'} navigation to:`, url);
  const startTime = Date.now();
  
  try {
    // Enhanced headers for Partsouq
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });
    
    // Navigate with better strategy
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: fullScrape ? 60000 : 30000
    });
    
    console.log(`📊 Response status: ${response?.status()}`);
    
    // בדיקה מהירה אם יש Cloudflare
    let title = await page.title();
    console.log(`📄 Initial title: ${title}`);
    
    if (title.includes('Just a moment') || title.includes('Checking your browser') || title.includes('Cloudflare')) {
      console.log('☁️ Cloudflare detected, handling challenge...');
      
      // Strategy 1: Wait for Cloudflare scripts to run
      try {
        // חכה שה-Cloudflare יסיים לרוץ
        await page.waitForFunction(
          () => {
            // בדוק אם יש את הטקסט של Cloudflare
            const text = document.body?.innerText || '';
            return !text.includes('Checking your browser') && 
                   !text.includes('Just a moment') &&
                   !document.title.includes('Just a moment');
          },
          { timeout: 20000, polling: 500 }
        );
        console.log('✅ Cloudflare challenge resolved!');
      } catch (e) {
        console.log('⏳ Still in Cloudflare, trying alternative method...');
        
        // Strategy 2: Click if there's a button/checkbox
        try {
          // נסה למצוא ולללחוץ על checkbox או כפתור
          const cfButton = await page.$('input[type="button"], input[type="submit"], .cf-browser-verification');
          if (cfButton) {
            await cfButton.click();
            console.log('🖱️ Clicked Cloudflare element');
            await page.waitForTimeout(3000);
          }
        } catch {}
        
        // Strategy 3: Wait more and check periodically
        for (let i = 0; i < 5; i++) {
          await page.waitForTimeout(3000);
          title = await page.title();
          const bodyText = await page.evaluate(() => document.body?.innerText || '');
          
          if (!title.includes('Just a moment') && 
              !bodyText.includes('Checking your browser')) {
            console.log(`✅ Cloudflare passed after ${(i+1)*3} seconds`);
            break;
          }
          console.log(`⏳ Waiting for Cloudflare... (${i+1}/5)`);
          
          // נסה reload אם תקוע
          if (i === 3) {
            console.log('🔄 Attempting reload...');
            await page.reload({ waitUntil: 'domcontentloaded' });
          }
        }
      }
      
      // Final wait for content to stabilize
      if (fullScrape) {
        console.log('⏳ Waiting for full page load...');
        try {
          await page.waitForSelector('.product-item, .part-number, .search-results, body', { 
            timeout: 10000 
          });
        } catch {
          console.log('⚠️ Could not find expected elements, continuing...');
        }
        await page.waitForTimeout(2000);
      }
      
    } else {
      console.log('✅ No Cloudflare detected');
      
      // אם זה full scrape, תן עוד קצת זמן לדף להיטען
      if (fullScrape) {
        try {
          await page.waitForLoadState('networkidle');
        } catch {}
        await page.waitForTimeout(2000);
      }
    }
    
    const html = await page.content();
    const finalUrl = page.url();
    const elapsed = Date.now() - startTime;
    
    // בדוק אם עדיין ב-Cloudflare
    if (html.includes('cf-browser-verification') || html.includes('cf_clearance')) {
      console.log('⚠️ Still showing Cloudflare page');
    }
    
    console.log(`⏱️ Completed in ${elapsed}ms`);
    console.log(`📏 HTML length: ${html.length} characters`);
    
    return {
      success: true,
      html: html,
      url: finalUrl,
      elapsed: elapsed
    };
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

async function scrapeWithCache(url, sessionId = null, fullScrape = false) {
  // בדוק cache קודם
  const cacheKey = `${url}_${sessionId || 'default'}_${fullScrape ? 'full' : 'url'}`;
  if (htmlCache.has(cacheKey)) {
    const cached = htmlCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('⚡ Cache hit! Returning immediately');
      return {
        success: true,
        html: cached.html,
        url: cached.url,
        fromCache: true
      };
    }
  }
  
  console.log(`📦 Session: ${sessionId || 'new'} | Mode: ${fullScrape ? 'FULL SCRAPE' : 'URL ONLY'}`);
  
  let browser = null;
  let page = null;
  
  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: BROWSER_ARGS,
      ignoreDefaultArgs: ['--enable-automation'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });
    
    page = await browser.newPage();
    
    // Enhanced stealth measures for Cloudflare
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver traces
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      
      // Add chrome object
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {}
      };
      
      // Fix plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      
      // Fix permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
      
      // Add languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });
      
      // Fix platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32'
      });
    });
    
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Load cookies if session exists
    if (sessionId && sessionCache.has(sessionId)) {
      const cookies = sessionCache.get(sessionId);
      if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log(`🍪 Using ${cookies.length} cookies`);
      }
    }
    
    // Fast bypass with fullScrape parameter
    const result = await fastCloudflareBypass(page, url, fullScrape);
    
    if (result.success) {
      // Save to cache
      htmlCache.set(cacheKey, {
        html: result.html,
        url: result.url,
        timestamp: Date.now()
      });
      
      // Save cookies
      if (sessionId) {
        const cookies = await page.cookies();
        sessionCache.set(sessionId, cookies);
      }
      
      // Clean old cache
      if (htmlCache.size > 50) {
        const firstKey = htmlCache.keys().next().value;
        htmlCache.delete(firstKey);
      }
    }
    
    return result;
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
    
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
  }
}

// Main endpoint
app.post('/v1', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { cmd, url, maxTimeout = 30000, session, fullScrape = false } = req.body;
    
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL is required'
      });
    }
    
    console.log(`\n🔨 Request: ${url} | Full Scrape: ${fullScrape}`);
    
    const sessionId = session || `auto_${Buffer.from(url).toString('base64').substring(0, 10)}`;
    
    // Scrape with timeout - מאפשר יותר זמן ל-full scrape
    const timeout = fullScrape ? maxTimeout * 2 : maxTimeout;
    
    const result = await Promise.race([
      scrapeWithCache(url, sessionId, fullScrape),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), timeout)
      )
    ]);
    
    if (result.success) {
      const elapsed = Date.now() - startTime;
      console.log(`✅ Total time: ${elapsed}ms ${result.fromCache ? '(from cache)' : ''}`);
      
      res.json({
        status: 'ok',
        message: result.fromCache ? 'From cache' : 'Success',
        solution: {
          url: result.url || url,
          status: 200,
          response: result.html,
          cookies: [],
          userAgent: 'Mozilla/5.0'
        },
        startTimestamp: startTime,
        endTimestamp: Date.now(),
        version: '2.1.0'
      });
    } else {
      throw new Error(result.error);
    }
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      solution: null
    });
  }
});

// Test endpoint
app.get('/test', async (req, res) => {
  try {
    const fullScrape = req.query.full === 'true';
    const result = await scrapeWithCache('https://example.com', null, fullScrape);
    
    if (result.success) {
      const title = result.html.match(/<title>(.*?)<\/title>/)?.[1];
      res.json({
        status: 'ok',
        title: title || 'No title',
        length: result.html.length,
        fromCache: result.fromCache || false,
        mode: fullScrape ? 'full' : 'url'
      });
    } else {
      throw new Error(result.error);
    }
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Test Partsouq
app.get('/test-partsouq', async (req, res) => {
  try {
    const vin = req.query.vin || 'NLHBB51CBEZ258560';
    const fullScrape = req.query.full === 'true';
    const url = `https://partsouq.com/en/search/all?q=${vin}`;
    
    console.log(`\n🧪 Testing Partsouq with VIN: ${vin} | Full: ${fullScrape}`);
    
    const result = await scrapeWithCache(url, `partsouq_${vin}`, fullScrape);
    
    if (result.success) {
      const hasProducts = result.html.includes('product') || 
                         result.html.includes('part') ||
                         result.html.includes(vin);
      
      res.json({
        status: 'ok',
        elapsed: result.elapsed + 'ms',
        length: result.html.length,
        hasProducts: hasProducts,
        url: result.url,
        fromCache: result.fromCache || false,
        mode: fullScrape ? 'full' : 'url'
      });
    } else {
      throw new Error(result.error);
    }
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.round(process.uptime()) + 's',
    sessions: sessionCache.size,
    htmlCache: htmlCache.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// Clear cache
app.post('/clear-cache', (req, res) => {
  const sessions = sessionCache.size;
  const pages = htmlCache.size;
  sessionCache.clear();
  htmlCache.clear();
  res.json({
    status: 'ok',
    cleared: {
      sessions: sessions,
      pages: pages
    }
  });
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <h1>⚡ Fast Puppeteer Scraper v2.1</h1>
    <p>Optimized for speed with dual-mode operation</p>
    <ul>
      <li>POST /v1 - Main endpoint (add fullScrape: true for complete scraping)</li>
      <li>GET /test - Test example.com</li>
      <li>GET /test-partsouq - Test Partsouq</li>
      <li>GET /health - System status</li>
      <li>POST /clear-cache - Clear all caches</li>
    </ul>
    <p>Cache: ${htmlCache.size} pages, ${sessionCache.size} sessions</p>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   ⚡ Fast Cloudflare Bypass v2.1       ║
║   Port: ${PORT}                           ║
║   Modes: URL-only / Full Scrape       ║
╚════════════════════════════════════════╝
  `);
});

// Clean old cache periodically
setInterval(() => {
  let cleaned = 0;
  const now = Date.now();
  
  // Clean HTML cache
  for (const [key, value] of htmlCache) {
    if (now - value.timestamp > CACHE_TTL) {
      htmlCache.delete(key);
      cleaned++;
    }
  }
  
  // Clean old sessions
  if (sessionCache.size > 100) {
    const toDelete = sessionCache.size - 50;
    let deleted = 0;
    for (const [key] of sessionCache) {
      if (deleted >= toDelete) break;
      sessionCache.delete(key);
      deleted++;
    }
    cleaned += deleted;
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} cache entries`);
  }
}, 60000); // Every minute
