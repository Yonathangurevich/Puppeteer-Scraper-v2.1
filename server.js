const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const PQueue = require('p-queue').default;

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const FLARESOLVERR_URLS = (process.env.FLARESOLVERR_URLS || '').split(',').filter(Boolean);

// Cache - TTL 5 minutes
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Queue - 3 concurrent requests
const queue = new PQueue({ concurrency: 3 });

// Session management
const sessions = new Map();
const SESSION_TTL = 120000; // 2 minutes

// Round-robin load balancing
let currentProvider = 0;

function getNextProvider() {
  if (FLARESOLVERR_URLS.length === 0) {
    throw new Error('No FlareSolverr providers configured');
  }
  const url = FLARESOLVERR_URLS[currentProvider];
  currentProvider = (currentProvider + 1) % FLARESOLVERR_URLS.length;
  return url;
}

// Clean old sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of sessions) {
    if (now - data.created > SESSION_TTL) {
      destroySession(id);
    }
  }
  console.log(`🧹 Active sessions: ${sessions.size}`);
}, 30000);

async function destroySession(sessionId) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return;
  
  try {
    await axios.post(`${sessionData.provider}/v1`, {
      cmd: 'sessions.destroy',
      session: sessionId
    });
  } catch (e) {
    // ignore
  }
  
  sessions.delete(sessionId);
  console.log(`🗑️ Session destroyed: ${sessionId}`);
}

// Main endpoint
app.post('/v1', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { cmd, url, session: requestSession } = req.body;
    
    // Check cache for GET requests
    if (cmd === 'request.get' && url) {
      const cached = cache.get(url);
      if (cached) {
        console.log(`⚡ Cache hit for: ${url}`);
        return res.json({
          ...cached,
          fromCache: true,
          elapsed: Date.now() - startTime
        });
      }
    }
    
    // Execute with queue
    const result = await queue.add(async () => {
      const provider = getNextProvider();
      console.log(`🔄 Using provider: ${provider}`);
      
      // Handle session commands
      if (cmd === 'sessions.create') {
        const sessionId = requestSession || 'auto_' + Date.now();
        sessions.set(sessionId, {
          provider,
          created: Date.now()
        });
      }
      
      // Make request
      const response = await axios.post(`${provider}/v1`, req.body, {
        timeout: 65000
      });
      
      // Cache successful GET requests
      if (cmd === 'request.get' && response.data.status === 'ok') {
        cache.set(url, response.data);
        console.log(`💾 Cached: ${url}`);
      }
      
      return response.data;
    });
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ Request completed in ${elapsed}ms`);
    
    res.json({
      ...result,
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

// Stats endpoint
app.get('/stats', (req, res) => {
  res.json({
    providers: FLARESOLVERR_URLS.length,
    sessions: sessions.size,
    cacheSize: cache.keys().length,
    queueSize: queue.size,
    queuePending: queue.pending,
    uptime: process.uptime()
  });
});

// Health check
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    providers: []
  };
  
  for (const url of FLARESOLVERR_URLS) {
    try {
      await axios.get(`${url}/health`, { timeout: 5000 });
      health.providers.push({ url, status: 'healthy' });
    } catch (e) {
      health.providers.push({ url, status: 'unhealthy' });
      health.status = 'degraded';
    }
  }
  
  res.json(health);
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🚀 Byparr Lite for Railway          ║
║   Port: ${PORT}                           ║
║   Providers: ${FLARESOLVERR_URLS.length}                      ║
║   Cache: Enabled (5 min)              ║
║   Queue: 3 concurrent                 ║
╚═══════════════════════════════════════╝
  `);
});
