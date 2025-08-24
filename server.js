const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;

// 🔥 כל ה-FlareSolverr URLs
const FLARESOLVERR_URLS = [
    'https://flaresolverr-production-d07b.up.railway.app',
    'https://flaresolverr-2-production.up.railway.app',
    'https://flaresolverr-3-production.up.railway.app',
    'https://flaresolverr-4-production.up.railway.app',
    'https://flaresolverr-5-production.up.railway.app',
    'https://flaresolverr-6-production.up.railway.app'
];

// Cache for 5 minutes
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Track sessions PER instance - רק למקרים מורכבים
const sessionsByInstance = new Map();
FLARESOLVERR_URLS.forEach(url => {
    sessionsByInstance.set(url, new Map());
});

// ניקוי sessions ישנים כל דקה
setInterval(async () => {
    const now = Date.now();
    let totalCleaned = 0;
    
    for (const [instanceUrl, sessions] of sessionsByInstance) {
        for (const [id, data] of sessions) {
            if (now - data.created > 120000) { // 2 minutes old
                try {
                    await axios.post(`${instanceUrl}/v1`, {
                        cmd: 'sessions.destroy',
                        session: id
                    }, { timeout: 3000 });
                    sessions.delete(id);
                    totalCleaned++;
                } catch (e) {
                    sessions.delete(id);
                }
            }
        }
    }
    
    if (totalCleaned > 0) {
        console.log(`🧹 Cleaned ${totalCleaned} old sessions`);
    }
}, 60000);

// Helper function to get FlareSolverr URL
function getFlareSolverrUrl(req) {
    // מקבל את ה-URL מה-body
    const urlParam = req.body.flaresolverrUrl;
    if (urlParam && FLARESOLVERR_URLS.includes(urlParam)) {
        return urlParam;
    }
    
    // ברירת מחדל - הראשון
    return FLARESOLVERR_URLS[0];
}

// Main endpoint - OPTIMIZED FOR SPEED
app.post('/v1', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { cmd, url, session: requestSession, maxTimeout = 30000 } = req.body;
        const flaresolverrUrl = getFlareSolverrUrl(req);
        
        console.log(`📍 Request to: ${flaresolverrUrl.split('//')[1].split('.')[0]}`);
        
        // בדוק cache קודם
        if (cmd === 'request.get' && url) {
            const cacheKey = url.includes('ssd=') ? 
                `complex_${url.match(/q=([^&]+)/)?.[1]}_${url.match(/gid=(\d+)/)?.[1]}` : 
                `simple_${url}`;
            
            const cached = cache.get(cacheKey);
            if (cached) {
                console.log(`⚡ Cache hit! Returning in ${Date.now() - startTime}ms`);
                return res.json({
                    ...cached,
                    fromCache: true,
                    elapsed: Date.now() - startTime
                });
            }
        }
        
        // 🚀 FAST PATH - בקשות פשוטות בלי sessions
        if (cmd === 'request.get' && !url.includes('ssd=')) {
            console.log('⚡ Fast path - no session needed');
            
            const response = await axios.post(`${flaresolverrUrl}/v1`, {
                cmd: 'request.get',
                url: url,
                maxTimeout: maxTimeout
            }, {
                timeout: maxTimeout + 5000
            });
            
            // Cache if successful
            if (response.data.status === 'ok') {
                const cacheKey = `simple_${url}`;
                cache.set(cacheKey, response.data);
                console.log('💾 Cached simple response');
            }
            
            console.log(`✅ Fast path completed in ${Date.now() - startTime}ms`);
            return res.json({
                ...response.data,
                elapsed: Date.now() - startTime,
                path: 'fast'
            });
        }
        
        // 🐢 SLOW PATH - רק לבקשות מורכבות עם ssd
        if (cmd === 'request.get' && url && url.includes('ssd=')) {
            console.log('🔧 Complex request detected - using session');
            
            const sessions = sessionsByInstance.get(flaresolverrUrl);
            const sessionId = `complex_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            
            // Create session
            await axios.post(`${flaresolverrUrl}/v1`, {
                cmd: 'sessions.create',
                session: sessionId
            }, { timeout: 5000 });
            
            sessions.set(sessionId, { created: Date.now() });
            console.log(`📦 Session created: ${sessionId}`);
            
            // Make request with session
            const response = await axios.post(`${flaresolverrUrl}/v1`, {
                cmd: 'request.get',
                url: url,
                session: sessionId,
                maxTimeout: maxTimeout
            }, {
                timeout: maxTimeout + 5000
            });
            
            // Destroy session ASYNCHRONOUSLY - לא מחכים!
            setImmediate(async () => {
                try {
                    await axios.post(`${flaresolverrUrl}/v1`, {
                        cmd: 'sessions.destroy',
                        session: sessionId
                    }, { timeout: 3000 });
                    sessions.delete(sessionId);
                    console.log(`✅ Session destroyed: ${sessionId}`);
                } catch (e) {
                    console.log(`⚠️ Failed to destroy session: ${sessionId}`);
                }
            });
            
            // Cache complex response
            if (response.data.status === 'ok') {
                const cacheKey = `complex_${url.match(/q=([^&]+)/)?.[1]}_${url.match(/gid=(\d+)/)?.[1]}`;
                cache.set(cacheKey, response.data);
                console.log('💾 Cached complex response');
            }
            
            console.log(`✅ Complex request completed in ${Date.now() - startTime}ms`);
            return res.json({
                ...response.data,
                elapsed: Date.now() - startTime,
                path: 'complex'
            });
        }
        
        // כל שאר הפקודות - העבר ישירות
        console.log(`📄 Forwarding command: ${cmd}`);
        const response = await axios.post(`${flaresolverrUrl}/v1`, req.body, {
            timeout: maxTimeout + 5000
        });
        
        console.log(`✅ Completed in ${Date.now() - startTime}ms`);
        res.json({
            ...response.data,
            elapsed: Date.now() - startTime
        });
        
    } catch (error) {
        console.error(`❌ Error after ${Date.now() - startTime}ms:`, error.message);
        res.status(500).json({
            status: 'error',
            message: error.message,
            elapsed: Date.now() - startTime
        });
    }
});

// Health check - פשוט ומהיר
app.get('/health', async (req, res) => {
    const totalSessions = Array.from(sessionsByInstance.values())
        .reduce((sum, sessions) => sum + sessions.size, 0);
    
    res.json({
        status: 'healthy',
        sessions: totalSessions,
        cache: cache.keys().length,
        instances: FLARESOLVERR_URLS.length
    });
});

// Stats endpoint
app.get('/stats', (req, res) => {
    const stats = {};
    for (const [url, sessions] of sessionsByInstance) {
        const name = url.split('//')[1].split('.')[0];
        stats[name] = sessions.size;
    }
    
    res.json({
        uptime: Math.round(process.uptime()) + 's',
        sessions: stats,
        cache: cache.keys().length,
        cacheKeys: cache.keys().slice(0, 5)
    });
});

// Manual cleanup
app.post('/cleanup', async (req, res) => {
    let totalCleaned = 0;
    
    for (const [instanceUrl, sessions] of sessionsByInstance) {
        for (const [sessionId] of sessions) {
            try {
                await axios.post(`${instanceUrl}/v1`, {
                    cmd: 'sessions.destroy',
                    session: sessionId
                }, { timeout: 2000 });
                totalCleaned++;
            } catch (e) {}
        }
        sessions.clear();
    }
    
    const cacheCount = cache.keys().length;
    cache.flushAll();
    
    res.json({
        cleaned: {
            sessions: totalCleaned,
            cache: cacheCount
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
            <title>⚡ Fast Resource Manager</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #1a1a1a; color: #fff; }
                h1 { color: #4CAF50; }
                .stats { background: #2a2a2a; padding: 15px; border-radius: 8px; margin: 20px 0; }
                .fast { color: #00ff00; }
                .slow { color: #ff9900; }
            </style>
        </head>
        <body>
            <h1>⚡ Fast Resource Manager v2.0</h1>
            <div class="stats">
                <h3>🚀 Optimization Strategy:</h3>
                <p class="fast">⚡ FAST PATH: Simple requests → Direct forwarding (no session)</p>
                <p class="slow">🐢 SLOW PATH: Complex requests with ssd → Session management</p>
            </div>
            <div class="stats">
                <h3>📊 Current Status:</h3>
                <p>Active Sessions: ${totalSessions}</p>
                <p>Cached Responses: ${cache.keys().length}</p>
                <p>Managed Instances: ${FLARESOLVERR_URLS.length}</p>
            </div>
            <div class="stats">
                <h3>⏱️ Expected Performance:</h3>
                <p>Cache Hit: ~1-5ms</p>
                <p>Simple Request: ~22s (same as direct)</p>
                <p>Complex Request: ~25-30s (minimal overhead)</p>
            </div>
        </body>
        </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════╗
║   ⚡ FAST Resource Manager v2.0            ║
║   Port: ${PORT}                              ║
║   Strategy: Fast path for simple requests ║
║   Sessions: Only for complex requests     ║
║   Cache: 5 minutes TTL                    ║
╚════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🔴 Shutting down...');
    process.exit(0);
});
