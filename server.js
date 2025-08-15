// server.js - Simple wrapper that connects to existing FlareSolverr
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
// Use the FlareSolverr Docker service URL
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-d07b.up.railway.app';

// Cache - 2 minutes TTL
const cache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

// Session management
const sessions = new Map();
const SESSION_TTL = 120000; // 2 minutes

// Clean old sessions every 30 seconds
setInterval(async () => {
  const now = Date.now();
  
  for (const [sessionId, data] of sessions) {
    if (now - data.created > SESSION_TTL) {
      try {
        await axios.post(`${FLARESOLVERR_URL}/v1`, {
          cmd: 'sessions.destroy',
          session: sessionId
        });
        sessions.delete(sessionId);
        console.log(`🗑️ Cleaned session: ${sessionId}`);
      } catch (e) {
        sessions.delete(sessionId);
      }
    }
  }
  
  console.log(`📊 Active sessions: ${sessions.size}, Cache entries: ${cache.keys().length}`);
}, 30000);

// Main endpoint
app.post('/v1', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { cmd, url, session: requestSession } = req.body;
    
    // Special handling for complex URLs with ssd parameter
    if (cmd === 'request.get' && url && url.includes('ssd=')) {
      console.log('🔗 Complex URL detected with ssd parameter');
      
      // Create a simplified cache key
      const vin = url.match(/q=([^&]+)/)?.[1] || '';
      const gid = url.match(/gid=(\d+)/)?.[1] || '';
      const cacheKey = `complex_${vin}_${gid}`;
      
      // Check cache
      const cached = cache.get(cacheKey);
      if (cached) {
        console.log('⚡ Cache hit for complex URL!');
        return res.json({
          ...cached,
          fromCache: true,
          elapsed: Date.now() - startTime
        });
      }
      
      // Make request with session for complex URLs
      let sessionId = requestSession;
      if (!sessionId) {
        sessionId = `auto_${Date.now()}`;
        
        // Create session
        await axios.post(`${FLARESOLVERR_URL}/v1`, {
          cmd: 'sessions.create',
          session: sessionId
        });
        
        sessions.set(sessionId, {
          created: Date.now(),
          requests: 0
        });
        
        console.log(`📦 Created session for complex URL: ${sessionId}`);
      }
      
      // Make the request
      console.log(`🔄 Fetching complex URL with session...`);
      const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        ...req.body,
        session: sessionId
      }, {
        timeout: 65000
      });
      
      // Update session stats
      if (sessions.has(sessionId)) {
        const sessionData = sessions.get(sessionId);
        sessionData.requests++;
        
        // Auto-cleanup after 5 requests
        if (sessionData.requests >= 5) {
          setTimeout(async () => {
            try {
              await axios.post(`${FLARESOLVERR_URL}/v1`, {
                cmd: 'sessions.destroy',
                session: sessionId
              });
              sessions.delete(sessionId);
              console.log(`♻️ Recycled session after ${sessionData.requests} requests`);
            } catch (e) {}
          }, 1000);
        }
      }
      
      // Cache successful response
      if (response.data.status === 'ok') {
        cache.set(cacheKey, response.data);
        console.log(`💾 Cached complex URL response`);
      }
      
      const elapsed = Date.now() - startTime;
      console.log(`✅ Complex URL fetched in ${elapsed}ms`);
      
      return res.json({
        ...response.data,
        elapsed
      });
    }
    
    // Regular URLs - check cache
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
      const sessionId = requestSession || 'auto_' + Date.now();
      sessions.set(sessionId, {
        created: Date.now(),
        requests: 0
      });
    }
    
    // Forward to FlareSolverr
    console.log(`🔄 Forwarding: ${cmd} ${url ? url.substring(0, 80) : ''}`);
    
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
    const response = await axios.get(`${FLARESOLVERR_URL}/health`, { timeout: 5000 });
    
    const memUsage = process.memoryUsage();
    
    res.json({
      status: 'healthy',
      wrapper: {
        memory: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        sessions: sessions.size,
        cache: cache.keys().length
      },
      flaresolverr: 'connected'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Stats
app.get('/stats', (req, res) => {
  const memUsage = process.memoryUsage();
  
  res.json({
    uptime: Math.round(process.uptime()) + 's',
    memory: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
    sessions: {
      active: sessions.size,
      list: Array.from(sessions.entries()).map(([id, data]) => ({
        id: id.substring(0, 20),
        age: Math.round((Date.now() - data.created) / 1000) + 's',
        requests: data.requests
      }))
    },
    cache: {
      size: cache.keys().length,
      keys: cache.keys().slice(0, 10)
    }
  });
});

// Manual cleanup
app.post('/cleanup', async (req, res) => {
  const sessionCount = sessions.size;
  
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
      cache: cache.keys().length
    }
  });
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <h1>🛡️ FlareSolverr Smart Wrapper</h1>
    <p>Optimized for complex URLs with ssd parameters</p>
    <ul>
      <li>POST /v1 - Main endpoint</li>
      <li>GET /health - Health check</li>
      <li>GET /stats - Statistics</li>
      <li>POST /cleanup - Manual cleanup</li>
    </ul>
    <p>
      Sessions: ${sessions.size} | 
      Cache: ${cache.keys().length} | 
      Target: ${FLARESOLVERR_URL}
    </p>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🛡️ FlareSolverr Smart Wrapper       ║
║   Port: ${PORT}                           ║
║   Target: ${FLARESOLVERR_URL.substring(0, 30)}...   ║
║   Complex URL Support: ✅             ║
║   Auto-cleanup: Every 30s             ║
╚═══════════════════════════════════════╝
  `);
});
