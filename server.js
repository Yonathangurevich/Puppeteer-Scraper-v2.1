const axios = require('axios');

// רשימת כל ה-FlareSolverr instances
const FLARESOLVERR_URLS = [
    'https://flaresolverr-production-d07b.up.railway.app',
    'https://flaresolverr-2-production.up.railway.app',
    'https://flaresolverr-3-production.up.railway.app',
    'https://flaresolverr-4-production.up.railway.app',
    'https://flaresolverr-5-production.up.railway.app',
    'https://flaresolverr-6-production.up.railway.app'
];

// פונקציה לניקוי sessions מ-instance אחד
async function cleanupInstance(url) {
    const instanceName = url.split('//')[1].split('.')[0];
    
    try {
        // קבל רשימת sessions
        const response = await axios.post(`${url}/v1`, {
            cmd: 'sessions.list'
        }, { timeout: 5000 });
        
        if (response.data && response.data.sessions) {
            const sessions = response.data.sessions;
            console.log(`📊 [${instanceName}] Found ${sessions.length} sessions`);
            
            // מחק כל session
            for (const sessionId of sessions) {
                try {
                    await axios.post(`${url}/v1`, {
                        cmd: 'sessions.destroy',
                        session: sessionId
                    }, { timeout: 3000 });
                    
                    console.log(`✅ [${instanceName}] Destroyed session: ${sessionId}`);
                } catch (err) {
                    console.log(`⚠️ [${instanceName}] Failed to destroy session: ${sessionId}`);
                }
            }
            
            return sessions.length;
        }
        
        return 0;
        
    } catch (error) {
        console.log(`❌ [${instanceName}] Error: ${error.message}`);
        return 0;
    }
}

// פונקציה ראשית לניקוי כל ה-instances
async function cleanupAll() {
    console.log('\n' + '='.repeat(50));
    console.log('🧹 Starting cleanup for all FlareSolverr instances');
    console.log('='.repeat(50));
    
    let totalCleaned = 0;
    
    // נקה כל instance במקביל
    const promises = FLARESOLVERR_URLS.map(url => cleanupInstance(url));
    const results = await Promise.allSettled(promises);
    
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            totalCleaned += result.value;
        }
    });
    
    console.log('='.repeat(50));
    console.log(`✨ Total sessions cleaned: ${totalCleaned}`);
    console.log(`⏰ Next cleanup in 5 minutes`);
    console.log('='.repeat(50) + '\n');
}

// הרץ ניקוי ראשוני
cleanupAll();

// הרץ ניקוי כל 5 דקות
setInterval(cleanupAll, 5 * 60 * 1000);

// Keep alive
console.log(`
╔═══════════════════════════════════════════════╗
║   🧹 FlareSolverr Cleanup Service            ║
║   Cleaning ${FLARESOLVERR_URLS.length} instances              ║
║   Every 5 minutes                            ║
╚═══════════════════════════════════════════════╝
`);

// מנע את סגירת התהליך
process.stdin.resume();
