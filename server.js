const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;

// 🔥 כל ה-FlareSolverr URLs שלך!
const FLARESOLVERR_URLS = [
    'https://flaresolverr-production-d07b.up.railway.app',
    'https://flaresolverr-2-production.up.railway.app',
    'https://flaresolverr-3-production.up.railway.app',
    'https://flaresolverr-4-production.up.railway.app',
    'https://flaresolverr-5-production.up.railway.app',
    'https://flaresolverr-6-production.up.railway.app'
];

// או קח מ-ENV variable
const TARGET_FLARESOLVERR = process.env.FLARESOLVERR_URL || FLARESOLVERR_URLS[0];

// Cache for 2 minutes
const cache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

// Track active sessions PER FlareSolverr instance
const sessionsByInstance = new Map();
FLARESOLVERR_URLS.forEach(url => {
    sessionsByInstance.set(url, new Map());
});

// 🔥 Clean ALL FlareSolverr instances every 30 seconds
setInterval(async () => {
    const now = Date.now();
    let totalCleaned = 0;
    
    console.log('🧹 Starting cleanup for all instances...');
    
    // נקה כל instance
    for (const [instanceUrl, sessions] of sessionsByInstance) {
        let cleaned = 0;
        const instanceName = instanceUrl.split('//')[1].split('.')[0];
        
        for (const [id, data] of sessions) {
            if (now - data.created > 120000) { // 2 minutes old
                try {
                    // Destroy session in specific FlareSolverr
                    await axios.post(`${instanceUrl}/v1`, {
                        cmd: 'sessions.destroy',
                        session: id
                    }, { timeout: 5000 });
                    
                    sessions.delete(id);
                    cleaned++;
                    console.log(`🗑️ [${instanceName}] Cleaned session: ${id}`);
                } catch (e) {
                    // Still delete from tracking even if destroy failed
                    sessions.delete(id);
                }
            }
        }
        
        if (cleaned > 0) {
            console.log(`✅ [${instanceName}] Cleaned ${cleaned} sessions. Active: ${sessions.size}`);
            totalCleaned += cleaned;
        }
    }
    
    // סיכום
    const totalSessions = Array.from(sessionsByInstance.values())
        .reduce((sum, sessions) => sum + sessions.size, 0);
    
    console.log(`📊 Total: Cleaned ${totalCleaned}, Active sessions: ${totalSessions}, Cache: ${cache.keys().length}`);
}, 30000);

// Helper function to get FlareSolverr URL from request
function getFlareSolverrUrl(req) {
    // אם יש header שמציין איזה instance
    const instanceIndex = req.headers['x-flaresolverr-instance'];
    if (instanceIndex && FLARESOLVERR_URLS[instanceIndex]) {
        return FLARESOLVERR_URLS[instanceIndex];
    }
    
    // או לפי URL parameter
    const urlParam = req.body.flaresolverrUrl;
    if (urlParam && FLARESOLVERR_URLS.includes(urlParam)) {
        return urlParam;
    }
    
    // ברירת מחדל - השתמש ב-TARGET_FLARESOLVERR
    return TARGET_FLARESOLVERR;
}

// Main endpoint
app.post('/v1', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { cmd, url, session: requestSession } = req.body;
        const flaresolverrUrl = getFlareSolverrUrl(req);
        const sessions = sessionsByInstance.get(flaresolverrUrl) || new Map();
        
        console.log(`🎯 Using FlareSolverr: ${flaresolverrUrl.split('//')[1].split('.')[0]}`);
        
        // For complex Partsouq URLs with ssd parameter
        if (cmd === 'request.get' && url && url.includes('partsouq.com') && url.includes('ssd=')) {
            console.log('🔗 Complex Partsouq URL detected!');
            
            // Create cache key
            const vin = url.match(/q=([^&]+)/)?.[1] || '';
            const gid = url.match(/gid=(\d+)/)?.[1] || '';
            const vid = url.match(/vid=(\d+)/)?.[1] || '';
            const cacheKey = `partsouq_${vin}_${gid}_${vid}`;
            
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
            
            // Create temporary session
            const sessionId = `complex_${Date.now()}`;
            
            console.log(`📦 Creating session: ${sessionId}`);
            await axios.post(`${flaresolverrUrl}/v1`, {
                cmd: 'sessions.create',
                session: sessionId
            });
            
            sessions.set(sessionId, { created: Date.now() });
            
            // Make request
            console.log('📄 Fetching with session...');
            const response = await axios.post(`${flaresolverrUrl}/v1`, {
                cmd: 'request.get',
                url: url,
                session: sessionId,
                maxTimeout: req.body.maxTimeout || 60000
            }, {
                timeout: 65000
            });
            
            // Destroy session after use
            setTimeout(async () => {
                try {
                    await axios.post(`${flaresolverrUrl}/v1`, {
                        cmd: 'sessions.destroy',
                        session: sessionId
                    });
                    sessions.delete(sessionId);
                    console.log(`✅ Session destroyed: ${sessionId}`);
                } catch (e) {}
            }, 1000);
            
            // Cache response
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
            console.log(`📍 Tracking session: ${sessionId} for ${flaresolverrUrl.split('//')[1].split('.')[0]}`);
        }
        
        // Track session destruction
        if (cmd === 'sessions.destroy' && requestSession) {
            sessions.delete(requestSession);
            console.log(`🗑️ Untracking session: ${requestSession}`);
        }
        
        // Forward to FlareSolverr
        console.log(`📄 Forwarding: ${cmd} ${url ? url.substring(0, 50) + '...' : ''}`);
        
        const response = await axios.post(`${flaresolverrUrl}/v1`, req.body, {
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
            elapsed,
            flaresolverr: flaresolverrUrl
        });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Health check for ALL instances
app.get('/health', async (req, res) => {
    try {
        const healthChecks = await Promise.allSettled(
            FLARESOLVERR_URLS.map(url => 
                axios.get(`${url}/health`, { timeout: 3000 })
                    .then(() => ({ url, status: 'healthy' }))
                    .catch(() => ({ url, status: 'error' }))
            )
        );
        
        const memUsage = process.memoryUsage();
        const totalSessions = Array.from(sessionsByInstance.values())
            .reduce((sum, sessions) => sum + sessions.size, 0);
        
        res.json({
            status: 'healthy',
            wrapper: {
                memory: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
                totalSessions: totalSessions,
                cache: cache.keys().length
            },
            flaresolverr: healthChecks.map(r => r.value || r.reason)
        });
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            error: error.message
        });
    }
});

// Stats endpoint - מציג סטטיסטיקות לכל instance
app.get('/stats', (req, res) => {
    const memUsage = process.memoryUsage();
    
    const instanceStats = {};
    for (const [url, sessions] of sessionsByInstance) {
        const name = url.split('//')[1].split('.')[0];
        instanceStats[name] = {
            sessions: sessions.size,
            list: Array.from(sessions.entries()).slice(0, 3).map(([id, data]) => ({
                id: id.substring(0, 20) + '...',
                age: Math.round((Date.now() - data.created) / 1000) + 's'
            }))
        };
    }
    
    res.json({
        uptime: Math.round(process.uptime()) + 's',
        memory: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        instances: instanceStats,
        cache: {
            size: cache.keys().length,
            keys: cache.keys().slice(0, 5).map(k => k.substring(0, 50) + '...')
        }
    });
});

// Manual cleanup for ALL instances
app.post('/cleanup', async (req, res) => {
    console.log('🧹 Manual cleanup requested for ALL instances');
    
    let totalSessions = 0;
    let totalCleaned = 0;
    
    // Cleanup all instances
    for (const [instanceUrl, sessions] of sessionsByInstance) {
        const instanceName = instanceUrl.split('//')[1].split('.')[0];
        const sessionCount = sessions.size;
        totalSessions += sessionCount;
        
        console.log(`🧹 Cleaning ${instanceName}: ${sessionCount} sessions`);
        
        // Destroy all sessions
        for (const [sessionId] of sessions) {
            try {
                await axios.post(`${instanceUrl}/v1`, {
                    cmd: 'sessions.destroy',
                    session: sessionId
                }, { timeout: 3000 });
                totalCleaned++;
            } catch (e) {
                console.log(`⚠️ Failed to destroy session ${sessionId} on ${instanceName}`);
            }
        }
        
        sessions.clear();
    }
    
    const cacheCount = cache.keys().length;
    cache.flushAll();
    
    res.json({
        status: 'ok',
        cleaned: {
            sessions: totalCleaned,
            totalSessions: totalSessions,
            cache: cacheCount,
            instances: FLARESOLVERR_URLS.length
        }
    });
});

// Root page
app.get('/', (req, res) => {
    const totalSessions = Array.from(sessionsByInstance.values())
        .reduce((sum, sessions) => sum + sessions.size, 0);
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Multi-Instance Resource Manager</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #1a1a1a; color: #fff; }
                h1 { color: #4CAF50; }
                .stats { background: #2a2a2a; padding: 15px; border-radius: 8px; margin: 20px 0; }
                .endpoint { background: #333; padding: 10px; margin: 10px 0; border-radius: 5px; }
                .instance { background: #2a2a2a; padding: 10px; margin: 5px 0; border-radius: 5px; }
                code { background: #000; padding: 2px 5px; border-radius: 3px; }
            </style>
        </head>
        <body>
            <h1>🛡️ Multi-Instance Resource Manager</h1>
            <div class="stats">
                <h3>📊 Current Status:</h3>
                <p>🔸 Total Active Sessions: ${totalSessions}</p>
                <p>🔸 Cached Responses: ${cache.keys().length}</p>
                <p>🔸 Managed Instances: ${FLARESOLVERR_URLS.length}</p>
            </div>
            <div class="stats">
                <h3>🎯 Managed FlareSolverr Instances:</h3>
                ${FLARESOLVERR_URLS.map((url, i) => `
                    <div class="instance">
                        ${i + 1}. ${url.split('//')[1]}
                    </div>
                `).join('')}
            </div>
            <div>
                <h3>🔧 Endpoints:</h3>
                <div class="endpoint">POST /v1 - Main proxy (supports all instances)</div>
                <div class="endpoint">GET /health - Health check all instances</div>
                <div class="endpoint">GET /stats - Detailed statistics per instance</div>
                <div class="endpoint">POST /cleanup - Manual cleanup all instances</div>
            </div>
            <div class="stats">
                <h3>✨ Enhanced Features:</h3>
                <p>✅ Manages ALL 6 FlareSolverr instances</p>
                <p>✅ Automatic cleanup every 30s for ALL instances</p>
                <p>✅ Per-instance session tracking</p>
                <p>✅ Smart caching for complex URLs</p>
                <p>✅ Health monitoring for all instances</p>
            </div>
        </body>
        </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════╗
║   🛡️ Multi-Instance Resource Manager      ║
║   Port: ${PORT}                              ║
║   Managing: ${FLARESOLVERR_URLS.length} FlareSolverr instances   ║
║   Auto-cleanup: Every 30s                ║
║   Special: Partsouq URL handling         ║
╚═══════════════════════════════════════════╝
    `);
    
    console.log('\n📋 Managed instances:');
    FLARESOLVERR_URLS.forEach((url, i) => {
        console.log(`   ${i + 1}. ${url.split('//')[1]}`);
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🔴 Shutting down, cleaning all sessions...');
    
    for (const [instanceUrl, sessions] of sessionsByInstance) {
        for (const [sessionId] of sessions) {
            try {
                await axios.post(`${instanceUrl}/v1`, {
                    cmd: 'sessions.destroy',
                    session: sessionId
                }, { timeout: 2000 });
            } catch (e) {}
        }
    }
    
    process.exit(0);
});
