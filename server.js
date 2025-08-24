const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8080;

// רשימת כל ה-FlareSolverr instances
const FLARESOLVERR_URLS = [
    'https://flaresolverr-production-d07b.up.railway.app',
    'https://flaresolverr-2-production.up.railway.app',
    'https://flaresolverr-3-production.up.railway.app',
    'https://flaresolverr-4-production.up.railway.app',
    'https://flaresolverr-5-production.up.railway.app',
    'https://flaresolverr-6-production.up.railway.app'
];

// מעקב אחר sessions ומתי הם נוצרו
const sessionsTracker = new Map();

// פונקציה לניקוי sessions ישנים בלבד
async function cleanupOldSessions() {
    console.log('\n' + '='.repeat(50));
    console.log('🧹 Smart cleanup - removing only OLD sessions');
    console.log('='.repeat(50));
    
    const now = Date.now();
    const MAX_AGE = 5 * 60 * 1000; // 5 דקות
    let totalCleaned = 0;
    
    for (const url of FLARESOLVERR_URLS) {
        const instanceName = url.split('//')[1].split('.')[0];
        
        try {
            // קבל רשימת sessions
            const response = await axios.post(`${url}/v1`, {
                cmd: 'sessions.list'
            }, { timeout: 5000 });
            
            if (response.data && response.data.sessions) {
                const sessions = response.data.sessions || [];
                console.log(`📊 [${instanceName}] Found ${sessions.length} sessions`);
                
                let cleaned = 0;
                for (const sessionId of sessions) {
                    // בדוק אם ה-session ישן מספיק
                    const sessionKey = `${url}_${sessionId}`;
                    const createdAt = sessionsTracker.get(sessionKey);
                    
                    // אם לא מכירים את ה-session, נניח שהוא ישן
                    const isOld = !createdAt || (now - createdAt > MAX_AGE);
                    
                    if (isOld) {
                        try {
                            await axios.post(`${url}/v1`, {
                                cmd: 'sessions.destroy',
                                session: sessionId
                            }, { timeout: 3000 });
                            
                            console.log(`✅ [${instanceName}] Cleaned old session: ${sessionId}`);
                            sessionsTracker.delete(sessionKey);
                            cleaned++;
                        } catch (err) {
                            console.log(`⚠️ [${instanceName}] Failed to destroy: ${sessionId}`);
                        }
                    } else {
                        const age = Math.round((now - createdAt) / 1000);
                        console.log(`⏳ [${instanceName}] Keeping active session: ${sessionId} (${age}s old)`);
                    }
                }
                
                console.log(`📈 [${instanceName}] Cleaned ${cleaned}/${sessions.length} sessions`);
                totalCleaned += cleaned;
            }
            
        } catch (error) {
            console.log(`❌ [${instanceName}] Error: ${error.message}`);
        }
    }
    
    console.log('='.repeat(50));
    console.log(`✨ Total old sessions cleaned: ${totalCleaned}`);
    console.log(`📊 Tracking ${sessionsTracker.size} active sessions`);
    console.log('='.repeat(50) + '\n');
}

// Endpoint לרישום session חדש (אופציונלי - אם תרצה לעקוב)
app.post('/register-session', express.json(), (req, res) => {
    const { url, sessionId } = req.body;
    if (url && sessionId) {
        const key = `${url}_${sessionId}`;
        sessionsTracker.set(key, Date.now());
        console.log(`📝 Registered new session: ${sessionId}`);
    }
    res.json({ status: 'ok' });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        trackedSessions: sessionsTracker.size,
        instances: FLARESOLVERR_URLS.length
    });
});

// Stats endpoint
app.get('/stats', (req, res) => {
    const stats = {
        totalInstances: FLARESOLVERR_URLS.length,
        trackedSessions: sessionsTracker.size,
        sessions: Array.from(sessionsTracker.entries()).map(([key, time]) => ({
            key: key.substring(0, 50) + '...',
            age: Math.round((Date.now() - time) / 1000) + 's'
        })).slice(0, 10)
    };
    res.json(stats);
});

// Manual cleanup endpoint
app.post('/cleanup', async (req, res) => {
    console.log('🔧 Manual cleanup triggered');
    await cleanupOldSessions();
    res.json({ status: 'completed' });
});

// Root page
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Smart Cleanup Service</title>
            <style>
                body { font-family: Arial; padding: 20px; background: #1a1a1a; color: #fff; }
                h1 { color: #4CAF50; }
                .stats { background: #2a2a2a; padding: 15px; border-radius: 8px; margin: 20px 0; }
                .warning { color: #ff9800; }
                .success { color: #4CAF50; }
            </style>
        </head>
        <body>
            <h1>🧹 Smart FlareSolverr Cleanup Service</h1>
            <div class="stats">
                <h3>📊 Status:</h3>
                <p>Managing: ${FLARESOLVERR_URLS.length} FlareSolverr instances</p>
                <p>Tracking: ${sessionsTracker.size} active sessions</p>
                <p>Cleanup: Every 2 minutes (only OLD sessions)</p>
            </div>
            <div class="stats">
                <h3 class="warning">⚠️ Smart Features:</h3>
                <p class="success">✅ Only removes sessions older than 5 minutes</p>
                <p class="success">✅ Keeps active/recent sessions alive</p>
                <p class="success">✅ Tracks session age</p>
            </div>
            <div class="stats">
                <h3>🔧 Endpoints:</h3>
                <p>GET /health - Health check</p>
                <p>GET /stats - Detailed statistics</p>
                <p>POST /cleanup - Manual cleanup</p>
            </div>
        </body>
        </html>
    `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║   🧹 Smart FlareSolverr Cleanup Service      ║
║   Port: ${PORT}                                 ║
║   Managing: ${FLARESOLVERR_URLS.length} instances                    ║
║   Strategy: Clean only OLD sessions          ║
║   Cleanup: Every 2 minutes                   ║
╚═══════════════════════════════════════════════╝
    `);
});

// הרץ ניקוי ראשוני אחרי 30 שניות
setTimeout(cleanupOldSessions, 30000);

// הרץ ניקוי כל 2 דקות
setInterval(cleanupOldSessions, 2 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🔴 Shutting down gracefully...');
    process.exit(0);
});
