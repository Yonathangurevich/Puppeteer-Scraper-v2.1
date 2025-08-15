const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191';

// Session management with auto-cleanup
const sessions = new Map();
const SESSION_TTL = 120000; // 2 minutes
const CLEANUP_INTERVAL = 30000; // Clean every 30 seconds

// Response cache for identical requests
const responseCache = new Map();
const CACHE_TTL = 60000; // 1 minute cache

// Stats
let totalRequests = 0;
let successfulRequests = 0;
let failedRequests = 0;
let cacheHits = 0;

// Create session with auto-cleanup
async function createSession() {
  try {
    const sessionId = crypto.randomBytes(16).toString('hex');
    
    const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'sessions.create',
      session: sessionId
    });
    
    if (response.data.status === 'ok') {
      sessions.set(sessionId, {
        created: Date.now(),
        lastUsed: Date.now(),
        requestCount: 0
      });
      
      console.log(`✅ Session created: ${sessionId}`);
      return sessionId;
    }
    
    throw new Error('Failed to create session');
  } catch (error) {
    console.error('❌ Session creation failed:', error.message);
    return null;
  }
}

// Destroy session
async function destroySession(sessionId) {
  try {
    await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'sessions.destroy',
      session: sessionId
    });
    
    sessions.delete(sessionId);
    console.log(`🗑️ Session destroyed: ${sessionId}`);
  } catch (error) {
    console.error(`Failed to destroy session ${sessionId}:`, error.message);
    sessions.delete(sessionId);
  }
}

// Clean old sessions
async function cleanupSessions() {
  const now = Date.now();
  const toDelete = [];
  
  for (const [sessionId, data] of sessions) {
    if (now - data.lastUsed > SESSION_TTL) {
      toDelete.push(sessionId);
    }
  }
  
  if (toDelete.length > 0) {
    console.log(`🧹 Cleaning ${toDelete.length} old sessions`);
    for (const sessionId of toDelete) {
      await destroySession(sessionId);
    }
  }
  
  // Clean old cache entries
  for (const [key, data] of responseCache) {
    if (now - data.timestamp > CACHE_TTL) {
      responseCache.delete(key);
    }
  }
}

// Get or create session
async function getSession() {
  // Find least used session
  let selectedSession = null;
  let minRequests = Infinity;
  
  for (const [sessionId, data] of sessions) {
    if (data.requestCount < minRequests) {
      selectedSession = sessionId;
      minRequests = data.requestCount;
    }
  }
  
  // Create new session if none exist or all are busy
  if (!selectedSession || minRequests > 5) {
    selectedSession = await createSession();
  }
  
  return selectedSession;
}

// Main scraping endpoint
app.post('/scrape', async (req, res) => {
  const startTime = Date.now();
  totalRequests++;
  
  try {
    const { url, maxTimeout = 60000, waitUntil = 'load', returnOnlyCookies = false } = req.body;
    
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL is required'
      });
    }
    
    console.log(`\n📥 Request: ${url}`);
    
    // Check cache
    const cacheKey = `${url}_${waitUntil}`;
    if (responseCache.has(cacheKey)) {
      const cached = responseCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        cacheHits++;
        console.log('⚡ Cache hit!');
        return res.json({
          ...cached.data,
          fromCache: true,
          elapsed: Date.now() - startTime
        });
      }
    }
    
    // Get or create session
    const sessionId = await getSession();
    if (!sessionId) {
      throw new Error('Could not create session');
    }
    
    // Update session stats
    const sessionData = sessions.get(sessionId);
    sessionData.requestCount++;
    sessionData.lastUsed = Date.now();
    
    console.log(`🔄 Using session: ${sessionId} (request #${sessionData.requestCount})`);
    
    // Make request to FlareSolverr
    const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get',
      url: url,
      session: sessionId,
      maxTimeout: maxTimeout,
      cookies: [],
      returnOnlyCookies: returnOnlyCookies,
      proxy: {}
    }, {
      timeout: maxTimeout + 5000
    });
    
    if (response.data.status === 'ok') {
      successfulRequests++;
      const elapsed = Date.now() - startTime;
      
      console.log(`✅ Success in ${elapsed}ms`);
      console.log(`📊 HTML size: ${response.data.solution.response?.length || 0} bytes`);
      
      // Cache successful response
      const responseData = {
        status: 'ok',
        solution: response.data.solution,
        startTimestamp: response.data.startTimestamp,
        endTimestamp: response.data.endTimestamp,
        version: response.data.version
      };
      
      responseCache.set(cacheKey, {
        data: responseData,
        timestamp: Date.now()
      });
      
      // Destroy session if it has been used too much
      if (sessionData.requestCount >= 10) {
        console.log(`♻️ Recycling session after ${sessionData.requestCount} requests`);
        setTimeout(() => destroySession(sessionId), 1000);
      }
      
      res.json({
        ...responseData,
        elapsed: elapsed
      });
      
    } else {
      throw new Error(response.data.message || 'Unknown error');
    }
    
  } catch (error) {
    failedRequests++;
    console.error('❌ Error:', error.message);
    
    res.status(500).json({
      status: 'error',
      message: error.message,
      solution: null
    });
  }
});

// Batch scraping endpoint
app.post('/scrape-batch', async (req, res) => {
  try {
    const { urls, maxTimeout = 60000 } = req.body;
    
    if (!urls || !Array.isArray(urls)) {
      return res.status(400).json({
        status: 'error',
        message: 'URLs array is required'
      });
    }
    
    console.log(`\n📦 Batch request for ${urls.length} URLs`);
    
    const results = [];
    
    // Process URLs in parallel with limit
    const batchSize = 3;
    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      
      const batchResults = await Promise.allSettled(
        batch.map(url => 
          axios.post(`http://localhost:${PORT}/scrape`, {
            url,
            maxTimeout
          })
        )
      );
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value.data);
        } else {
          results.push({
            status: 'error',
            message: result.reason.message
          });
        }
      }
    }
    
    res.json({
      status: 'ok',
      results: results
    });
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Direct proxy to FlareSolverr (for compatibility)
app.post('/v1', async (req, res) => {
  try {
    const response = await axios.post(`${FLARESOLVERR_URL}/v1`, req.body);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.response?.data?.message || error.message
    });
  }
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const stats = {
    uptime: Math.round(process.uptime()) + 's',
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    activeSessions: sessions.size,
    cacheEntries: responseCache.size,
    requests: {
      total: totalRequests,
      successful: successfulRequests,
      failed: failedRequests,
      cacheHits: cacheHits,
      successRate: totalRequests > 0 ? 
        Math.round((successfulRequests / totalRequests) * 100) + '%' : 'N/A'
    }
  };
  
  res.json(stats);
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const response = await axios.get(`${FLARESOLVERR_URL}/health`);
    res.json({
      status: 'healthy',
      flaresolverr: response.data,
      wrapper: {
        sessions: sessions.size,
        cache: responseCache.size
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Clear all sessions
app.post('/clear', async (req, res) => {
  console.log('🧹 Clearing all sessions and cache');
  
  const sessionCount = sessions.size;
  const cacheCount = responseCache.size;
  
  // Destroy all sessions
  for (const sessionId of sessions.keys()) {
    await destroySession(sessionId);
  }
  
  // Clear cache
  responseCache.clear();
  
  res.json({
    status: 'ok',
    cleared: {
      sessions: sessionCount,
      cache: cacheCount
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>🛡️ FlareSolverr Wrapper for Railway</h1>
    <p>Optimized for performance with auto-cleanup</p>
    <ul>
      <li>POST /scrape - Scrape single URL</li>
      <li>POST /scrape-batch - Scrape multiple URLs</li>
      <li>POST /v1 - Direct FlareSolverr proxy</li>
      <li>GET /stats - View statistics</li>
      <li>GET /health - Health check</li>
      <li>POST /clear - Clear all sessions</li>
    </ul>
    <p>Active sessions: ${sessions.size} | Cache: ${responseCache.size}</p>
  `);
});

// Start cleanup interval
setInterval(cleanupSessions, CLEANUP_INTERVAL);

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🛡️ FlareSolverr Wrapper              ║
║   Port: ${PORT}                           ║
║   FlareSolverr: ${FLARESOLVERR_URL}          ║
║   Auto-cleanup: Enabled               ║
╚═══════════════════════════════════════╝
  `);
  
  // Create initial session
  createSession();
});
