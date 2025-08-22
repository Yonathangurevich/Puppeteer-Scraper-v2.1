const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
const FLARESOLVERR_URL = 'https://flaresolverr-production-d07b.up.railway.app';

// Cache for 2 minutes
const cache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

// Track active sessions
const sessions = new Map();

// Clean old sessions every 30 seconds
setInterval(async () => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [id, data] of sessions) {
    if (now - data.created > 120000) { // 2 minutes old
      try {
        // Destroy session in FlareSolverr
        await axios.post(`${FLARESOLVERR_URL}/v1`, {
          cmd: 'sessions.destroy',
          session: id
        });
        sessions.delete(id);
        cleaned++;
        console.log(`🗑️ Cleaned session: ${id}`);
      } catch (e) {
        sessions.delete(id);
      }
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} sessions. Active: ${sessions.size}`);
  } else {
    console.log(`📊 Sessions: ${sessions.size}, Cache: ${cache.keys().length}`);
  }
}, 30000);

// Main endpoint
app.post('/v1', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { cmd, url, session: requestSession } = req.body;
    
    // For complex Partsouq URLs with ssd parameter
    if (cmd === 'request.get' && url && url.includes('partsouq.com') && url.includes('ssd=')) {
      console.log('🔗 Complex Partsouq URL detected!');
      
      // Create cache key from URL parts
      const vin = url.match(/q=([^&]+)/)?.[1] || '';
      const gid = url.match(/gid=(\d+)/)?.[1] || '';
      const vid = url.match(/vid=(\d+)/)?.[1] || '';
      const cacheKey = `partsouq_${vin}_${gid}_${vid}`;
      
      // Check cache first
      const cached = cache.get(cacheKey);
      if (cached) {
        console.log('⚡ Cache hit for complex URL!');
        return res.json({
          ...cached,
          fromCache: true,
          elapsed: Date.now() - startTime
        });
      }
      
      // Create temporary session for complex URL
      const sessionId = `complex_${Date.now()}`;
      
      console.log(`📦 Creating session: ${sessionId}`);
      await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'sessions.create',
        session: sessionId
      });
      
      sessions.set(sessionId, { created: Date.now() });
      
      // Make request with session
      console.log('🔄 Fetching with session...');
      const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'request.get',
        url: url,
        session: sessionId,
        maxTimeout: req.body.maxTimeout || 60000
      }, {
        timeout: 65000
      });
      
      // Destroy session immediately after use
      setTimeout(async () => {
        try {
          await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'sessions.destroy',
            session: sessionId
          });
          sessions.delete(sessionId);
          console.log(`✅ Session destroyed: ${sessionId}`);
        } catch (e) {}
      }, 1000);
      
      // Cache successful response
      if (response.data.status === 'ok') {
        cache.set(cacheKey, response.data);
        console.log('💾 Cached complex URL response');
      }
      
      const elapsed = Date.now() - startTime;
      console.log(`✅ Completed in ${elapsed}ms`);
      
      return res.json({
        ...response.data,
        elapsed
      });
    }
    
    // For regular URLs - check cache
    if (cmd === 'request.get' && url) {
      const cached = cache.get(url);
      if (cached) {
        console.log('⚡ Cache hit!');
        return res.json({
          ...cached,
          fromCache: true,
          elapsed: Date.now() - startTime
        });
      }
    }
    
    // Track session creation
    if (cmd === 'sessions.create') {
      const sessionId = requestSession || `auto_${Date.now()}`;
      sessions.set(sessionId, { created: Date.now() });
      console.log(`📝 Tracking session: ${sessionId}`);
    }
    
    // Track session destruction
    if (cmd === 'sessions.destroy' && requestSession) {
      sessions.delete(requestSession);
      console.log(`🗑️ Untracking session: ${requestSession}`);
    }
    
    // Forward to FlareSolverr
    console.log(`🔄 Forwarding: ${cmd} ${url ? url.substring(0, 50) + '...' : ''}`);
    
    const response = await axios.post(`${FLARESOLVERR_URL}/v1`, req.body, {
      timeout: 65000
    });
    
    // Cache successful GET requests
    if (cmd === 'request.get' && response.data.status === 'ok' && url) {
      cache.set(url, response.data);
      console.log('💾 Cached response');
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ Completed in ${elapsed}ms`);
    
    res.json({
      ...response.data,
      elapsed
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const flaresolverrHealth = await axios.get(`${FLARESOLVERR_URL}/health`, { 
      timeout: 5000 
    }).catch(() => null);
    
    const memUsage = process.memoryUsage();
    
    res.json({
      status: 'healthy',
      wrapper: {
        memory: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        sessions: sessions.size,
        cache: cache.keys().length
      },
      flaresolverr: flaresolverrHealth ? 'connected' : 'error'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const memUsage = process.memoryUsage();
  
  res.json({
    uptime: Math.round(process.uptime()) + 's',
    memory: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
    sessions: {
      active: sessions.size,
      list: Array.from(sessions.entries()).map(([id, data]) => ({
        id: id.substring(0, 30) + '...',
        age: Math.round((Date.now() - data.created) / 1000) + 's'
      }))
    },
    cache: {
      size: cache.keys().length,
      keys: cache.keys().slice(0, 5).map(k => k.substring(0, 50) + '...')
    }
  });
});

// Manual cleanup
app.post('/cleanup', async (req, res) => {
  console.log('🧹 Manual cleanup requested');
  
  const sessionCount = sessions.size;
  const cacheCount = cache.keys().length;
  
  // Destroy all sessions
  for (const [sessionId] of sessions) {
    try {
      await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'sessions.destroy',
        session: sessionId
      });
    } catch (e) {}
  }
  
  sessions.clear();
  cache.flushAll();
  
  res.json({
    status: 'ok',
    cleaned: {
      sessions: sessionCount,
      cache: cacheCount
    }
  });
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Resource Manager</title>
      <style>
        body { font-family: Arial; padding: 20px; background: #1a1a1a; color: #fff; }
        h1 { color: #4CAF50; }
        .stats { background: #2a2a2a; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .endpoint { background: #333; padding: 10px; margin: 10px 0; border-radius: 5px; }
        code { background: #000; padding: 2px 5px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <h1>🛡️ Resource Manager for FlareSolverr</h1>
      <div class="stats">
        <h3>📊 Current Status:</h3>
        <p>🔸 Active Sessions: ${sessions.size}</p>
        <p>🔸 Cached Responses: ${cache.keys().length}</p>
        <p>🔸 Target: ${FLARESOLVERR_URL}</p>
      </div>
      <div>
        <h3>🔧 Endpoints:</h3>
        <div class="endpoint">POST /v1 - Main proxy (FlareSolverr compatible)</div>
        <div class="endpoint">GET /health - Health check</div>
        <div class="endpoint">GET /stats - Detailed statistics</div>
        <div class="endpoint">POST /cleanup - Manual cleanup</div>
      </div>
      <div class="stats">
        <h3>✨ Features:</h3>
        <p>✅ Automatic session cleanup every 30 seconds</p>
        <p>✅ Smart caching for complex Partsouq URLs</p>
        <p>✅ Session management for ssd parameter URLs</p>
        <p>✅ Memory efficient operation</p>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🛡️ Resource Manager Started         ║
║   Port: ${PORT}                           ║
║   Target: FlareSolverr                ║
║   Auto-cleanup: Every 30s             ║
║   Special handling: Partsouq URLs     ║
╚═══════════════════════════════════════╝
  `);
});
