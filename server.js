// server.js - FlareSolverr Wrapper with Resource Management
const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8191;
const FLARESOLVERR_PORT = 8192;
const FLARESOLVERR_URL = `http://localhost:${FLARESOLVERR_PORT}`;

// Cache for results - 2 minutes TTL
const cache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

// Session tracking
const sessions = new Map();
const SESSION_TTL = 120000; // 2 minutes

let flaresolverrProcess = null;
let isRestarting = false;

// Start FlareSolverr subprocess
async function startFlareSolverr() {
  console.log('🚀 Starting FlareSolverr...');
  
  const env = {
    ...process.env,
    PORT: FLARESOLVERR_PORT,
    LOG_LEVEL: 'info',
    LOG_HTML: 'false',
    CAPTCHA_SOLVER: 'none',
    BROWSER_TIMEOUT: '40000',
    MAX_TIMEOUT: '60000',
    TEST_URL: 'https://www.google.com'
  };
  
  flaresolverrProcess = spawn('python', ['-m', 'flaresolverr'], {
    env: env,
    stdio: 'pipe'
  });
  
  flaresolverrProcess.stdout.on('data', (data) => {
    console.log(`FlareSolverr: ${data}`);
  });
  
  flaresolverrProcess.stderr.on('data', (data) => {
    console.error(`FlareSolverr Error: ${data}`);
  });
  
  flaresolverrProcess.on('exit', (code) => {
    console.log(`FlareSolverr exited with code ${code}`);
    if (!isRestarting) {
      setTimeout(startFlareSolverr, 5000);
    }
  });
  
  // Wait for FlareSolverr to be ready
  await waitForFlareSolverr();
  console.log('✅ FlareSolverr is ready!');
}

async function waitForFlareSolverr() {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await axios.get(`${FLARESOLVERR_URL}/health`);
      if (response.status === 200) return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('FlareSolverr failed to start');
}

// Restart FlareSolverr if memory usage is high
async function checkAndRestartIfNeeded() {
  const memUsage = process.memoryUsage();
  const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  
  console.log(`📊 Memory usage: ${memMB}MB`);
  
  if (memMB > 1500) {
    console.log('⚠️ High memory usage detected, restarting FlareSolverr...');
    await restartFlareSolverr();
  }
}

async function restartFlareSolverr() {
  isRestarting = true;
  
  // Clean all sessions first
  await cleanAllSessions();
  
  // Kill FlareSolverr
  if (flaresolverrProcess) {
    flaresolverrProcess.kill();
    await new Promise(r => setTimeout(r, 2000));
  }
  
  // Clear cache
  cache.flushAll();
  
  // Restart
  isRestarting = false;
  await startFlareSolverr();
}

// Clean sessions
async function cleanAllSessions() {
  console.log('🧹 Cleaning all sessions...');
  
  for (const [sessionId, data] of sessions) {
    try {
      await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'sessions.destroy',
        session: sessionId
      });
    } catch (e) {
      // ignore
    }
  }
  
  sessions.clear();
  console.log('✅ All sessions cleaned');
}

// Clean old sessions periodically
setInterval(async () => {
  const now = Date.now();
  const toDelete = [];
  
  for (const [sessionId, data] of sessions) {
    if (now - data.created > SESSION_TTL) {
      toDelete.push(sessionId);
    }
  }
  
  for (const sessionId of toDelete) {
    try {
      await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'sessions.destroy',
        session: sessionId
      });
      sessions.delete(sessionId);
      console.log(`🗑️ Deleted old session: ${sessionId}`);
    } catch (e) {
      sessions.delete(sessionId);
    }
  }
  
  // Check memory
  await checkAndRestartIfNeeded();
  
}, 30000); // Every 30 seconds

// Main endpoint - handles complex URLs
app.post('/v1', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { cmd, url, session: requestSession, maxTimeout = 60000 } = req.body;
    
    // Check cache for GET requests with complex URLs
    if (cmd === 'request.get' && url) {
      // Use a simpler cache key for complex URLs
      const cacheKey = url.includes('ssd=') ? 
        url.split('ssd=')[0] + url.split('&q=')[1] : 
        url;
      
      const cached = cache.get(cacheKey);
      if (cached) {
        console.log(`⚡ Cache hit for complex URL`);
        return res.json({
          ...cached,
          fromCache: true,
          elapsed: Date.now() - startTime
        });
      }
    }
    
    // Track session
    if (cmd === 'sessions.create') {
      const sessionId = requestSession || 'auto_' + Date.now();
      sessions.set(sessionId, {
        created: Date.now(),
        requests: 0
      });
    }
    
    // Forward to FlareSolverr
    console.log(`🔄 Processing: ${cmd}`);
    if (url) {
      console.log(`📍 URL: ${url.substring(0, 100)}...`);
    }
    
    const response = await axios.post(`${FLARESOLVERR_URL}/v1`, req.body, {
      timeout: maxTimeout + 5000
    });
    
    // Update session stats
    if (requestSession && sessions.has(requestSession)) {
      const sessionData = sessions.get(requestSession);
      sessionData.requests++;
      
      // Auto-destroy session after 10 requests
      if (sessionData.requests >= 10) {
        console.log(`♻️ Recycling session after ${sessionData.requests} requests`);
        setTimeout(async () => {
          try {
            await axios.post(`${FLARESOLVERR_URL}/v1`, {
              cmd: 'sessions.destroy',
              session: requestSession
            });
            sessions.delete(requestSession);
          } catch (e) {}
        }, 1000);
      }
    }
    
    // Cache successful complex URL responses
    if (cmd === 'request.get' && response.data.status === 'ok' && url) {
      const cacheKey = url.includes('ssd=') ? 
        url.split('ssd=')[0] + url.split('&q=')[1] : 
        url;
      
      cache.set(cacheKey, response.data);
      console.log(`💾 Cached complex URL response`);
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
    const flaresolverrHealth = await axios.get(`${FLARESOLVERR_URL}/health`);
    
    const memUsage = process.memoryUsage();
    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    res.json({
      status: 'healthy',
      memory: `${memMB}MB`,
      sessions: sessions.size,
      cacheSize: cache.keys().length,
      flaresolverr: flaresolverrHealth.data
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
    uptime: process.uptime(),
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
    },
    sessions: {
      active: sessions.size,
      details: Array.from(sessions.entries()).map(([id, data]) => ({
        id,
        age: Math.round((Date.now() - data.created) / 1000) + 's',
        requests: data.requests
      }))
    },
    cache: {
      size: cache.keys().length,
      keys: cache.keys()
    }
  });
});

// Manual cleanup
app.post('/cleanup', async (req, res) => {
  await cleanAllSessions();
  cache.flushAll();
  
  res.json({
    status: 'ok',
    message: 'Cleaned all sessions and cache'
  });
});

// Restart FlareSolverr
app.post('/restart', async (req, res) => {
  res.json({ status: 'ok', message: 'Restarting FlareSolverr...' });
  
  setTimeout(async () => {
    await restartFlareSolverr();
  }, 100);
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <h1>🛡️ FlareSolverr Managed</h1>
    <p>Optimized for complex URLs with auto-cleanup</p>
    <ul>
      <li>POST /v1 - Main endpoint (FlareSolverr compatible)</li>
      <li>GET /health - Health check</li>
      <li>GET /stats - Detailed statistics</li>
      <li>POST /cleanup - Manual cleanup</li>
      <li>POST /restart - Restart FlareSolverr</li>
    </ul>
    <p>Sessions: ${sessions.size} | Cache: ${cache.keys().length}</p>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🛡️ FlareSolverr Managed             ║
║   Port: ${PORT}                           ║
║   Auto-cleanup: Every 30s             ║
║   Session TTL: 2 minutes              ║
║   Cache TTL: 2 minutes                ║
║   Auto-restart: At 1.5GB RAM          ║
╚═══════════════════════════════════════╝
  `);
  
  // Start FlareSolverr
  await startFlareSolverr();
});
