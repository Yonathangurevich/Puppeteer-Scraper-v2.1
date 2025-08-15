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

async function fastCloudflareBypass(page, url) {
  console.log('🚀 Starting fast navigation to:', url);
  const startTime = Date.now();
  
  try {
    // Navigate פעם אחת
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    
    // בדיקה מהירה אם יש Cloudflare
    const title = await page.title();
    console.log(`📄 Initial title: ${title}`);
    
    if (title.includes('Just a moment') || title.includes('Checking your browser')) {
      console.log('☁️ Cloudflare detected, waiting...');
      
      // נסה רק 3 פעמים עם המתנה קצרה
      for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(2000); // 2 שניות במקום 3
        
        const newTitle = await page.title();
        if (!newTitle.includes('Just a moment')) {
          console.log(`✅ Cloudflare passed after ${i + 1} attempts`);
          break;
        }
        
        console.log(`⏳ Still waiting... (${i + 1}/3)`);
      }
    } else {
      console.log('✅ No Cloudflare detected');
    }
    
    const html = await page.content();
    const finalUrl = page.url();
    const elapsed = Date.now() - startTime;
    
    console.log(`⏱️ Completed in ${elapsed}ms`);
    
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

async function scrapeWithCache(url, sessionId = null) {
  // בדוק cache קודם
  const cacheKey = `${url}_${sessionId || 'default'}`;
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
  
  console.log(`📦 Session: ${sessionId || 'new'}`);
  
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
    
    // Stealth measures
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
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
    
    // Fast bypass
    const result = await fastCloudflareBypass(page, url);
    
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
    const { cmd, url, maxTimeout = 30000, session } = req.body;
    
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL is required'
      });
    }
    
    console.log(`\n📨 Request: ${url}`);
    
    const sessionId = session || `auto_${Buffer.from(url).toString('base64').substring(0, 10)}`;
    
    // Scrape with timeout
    const result = await Promise.race([
      scrapeWithCache(url, sessionId),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), maxTimeout)
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
        version: '2.0.0'
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
    const result = await scrapeWithCache('https://example.com');
    
    if (result.success) {
      const title = result.html.match(/<title>(.*?)<\/title>/)?.[1];
      res.json({
        status: 'ok',
        title: title || 'No title',
        length: result.html.length,
        fromCache: result.fromCache || false
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
    const url = `https://partsouq.com/en/search/all?q=${vin}`;
    
    console.log(`\n🧪 Testing Partsouq with VIN: ${vin}`);
    
    const result = await scrapeWithCache(url, `partsouq_${vin}`);
    
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
        fromCache: result.fromCache || false
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
    <h1>⚡ Fast Puppeteer Scraper v2</h1>
    <p>Optimized for speed with caching</p>
    <ul>
      <li>POST /v1 - Main endpoint</li>
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
╔═══════════════════════════════════════╗
║   ⚡ Fast Cloudflare Bypass v2        ║
║   Port: ${PORT}                           ║
║   Strategy: 3 attempts + Cache        ║
╚═══════════════════════════════════════╝
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
