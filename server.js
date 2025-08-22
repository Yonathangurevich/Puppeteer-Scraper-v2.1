const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Browser instance (single persistent browser)
let browser = null;

// Minimal browser args for speed
const BROWSER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--single-process',
    '--disable-extensions',
    '--disable-plugins',
    '--disable-images',
    '--disable-javascript', // כן! אנחנו לא צריכים JS בכלל
    '--disable-default-apps',
    '--disable-translate',
    '--disable-sync',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--mute-audio',
    '--no-zygote'
];

// Initialize browser once
async function initBrowser() {
    if (!browser) {
        browser = await puppeteer.launch({
            headless: 'new',
            args: BROWSER_ARGS,
            ignoreDefaultArgs: ['--enable-automation']
        });
        console.log('✅ Browser initialized');
    }
    return browser;
}

// Ultra-fast URL extraction
async function grabUrlFast(url) {
    const startTime = Date.now();
    let page = null;
    
    try {
        // Get or create browser
        if (!browser) {
            browser = await initBrowser();
        }
        
        // Create page with minimal overhead
        page = await browser.newPage();
        
        // Disable everything we don't need
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            // Block EVERYTHING except the main document
            if (resourceType !== 'document') {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        // Set minimal headers
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        console.log('🚀 Navigating to:', url);
        
        // Navigate with SHORT timeout - we don't need to wait for full load
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded', // Don't wait for all resources
                timeout: 5000 // Max 5 seconds
            });
        } catch (e) {
            // Ignore timeout - we might already have what we need
            console.log('⚡ Quick navigation timeout - checking URL anyway');
        }
        
        // Immediately check URL
        let currentUrl = page.url();
        console.log('📍 Current URL after navigation:', currentUrl);
        
        // If we already have ssd parameter - we're done!
        if (currentUrl.includes('ssd=')) {
            const elapsed = Date.now() - startTime;
            console.log(`✅ Found ssd parameter immediately! Time: ${elapsed}ms`);
            
            return {
                success: true,
                url: currentUrl,
                elapsed: elapsed,
                hasSsd: true
            };
        }
        
        // Wait maximum 3 seconds for redirect
        const maxWaitTime = 3000;
        const checkInterval = 200; // Check every 200ms
        const maxChecks = maxWaitTime / checkInterval;
        
        for (let i = 0; i < maxChecks; i++) {
            await page.waitForTimeout(checkInterval);
            currentUrl = page.url();
            
            if (currentUrl.includes('ssd=')) {
                const elapsed = Date.now() - startTime;
                console.log(`✅ Got ssd parameter after ${i + 1} checks! Time: ${elapsed}ms`);
                
                return {
                    success: true,
                    url: currentUrl,
                    elapsed: elapsed,
                    hasSsd: true
                };
            }
            
            // Check if URL changed at all (means redirect happened)
            if (currentUrl !== url && currentUrl.includes('/catalog/')) {
                const elapsed = Date.now() - startTime;
                console.log(`✅ URL changed to catalog! Time: ${elapsed}ms`);
                
                return {
                    success: true,
                    url: currentUrl,
                    elapsed: elapsed,
                    hasSsd: currentUrl.includes('ssd=')
                };
            }
        }
        
        // Last attempt - get current URL even without ssd
        const elapsed = Date.now() - startTime;
        console.log(`⚠️ Timeout reached, returning current URL. Time: ${elapsed}ms`);
        
        return {
            success: true,
            url: currentUrl,
            elapsed: elapsed,
            hasSsd: false
        };
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        return {
            success: false,
            error: error.message,
            url: url
        };
        
    } finally {
        // Close page quickly
        if (page) {
            await page.close().catch(() => {});
        }
    }
}

// Main endpoint
app.post('/v1', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({
                status: 'error',
                message: 'URL is required'
            });
        }
        
        console.log(`\n${'='.repeat(50)}`);
        console.log(`⚡ ULTRA FAST REQUEST`);
        console.log(`🔗 URL: ${url}`);
        console.log(`${'='.repeat(50)}\n`);
        
        // Execute with hard timeout of 6 seconds
        const result = await Promise.race([
            grabUrlFast(url),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Hard timeout 6s')), 6000)
            )
        ]);
        
        const totalTime = Date.now() - startTime;
        
        if (result.success) {
            console.log(`\n✅ SUCCESS in ${totalTime}ms`);
            console.log(`🔗 Final URL: ${result.url}`);
            console.log(`🎯 Has ssd: ${result.hasSsd ? 'YES' : 'NO'}\n`);
            
            res.json({
                status: 'ok',
                message: 'Success',
                solution: {
                    url: result.url,
                    status: 200,
                    response: `<html><body>URL Captured: ${result.url}</body></html>`,
                    cookies: [],
                    userAgent: 'Mozilla/5.0'
                },
                startTimestamp: startTime,
                endTimestamp: Date.now(),
                version: '5.0-FAST',
                hasSsd: result.hasSsd
            });
        } else {
            throw new Error(result.error || 'Failed to get URL');
        }
        
    } catch (error) {
        console.error(`❌ Failed: ${error.message}`);
        
        res.status(500).json({
            status: 'error', 
            message: error.message,
            solution: null
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        mode: 'ULTRA_FAST',
        maxResponseTime: '6 seconds',
        version: '5.0-FAST'
    });
});

// Root
app.get('/', (req, res) => {
    res.send(`
        <h1>⚡ Ultra Fast URL Grabber v5.0</h1>
        <p><strong>Mode:</strong> SPEED OPTIMIZED</p>
        <p><strong>Target Time:</strong> 3-5 seconds</p>
        <p><strong>Features:</strong></p>
        <ul>
            <li>✅ Blocks ALL resources except main document</li>
            <li>✅ JavaScript disabled for speed</li>
            <li>✅ Minimal wait times</li>
            <li>✅ Single persistent browser</li>
            <li>✅ Hard timeout 6 seconds</li>
        </ul>
    `);
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`
╔═══════════════════════════════════════╗
║  ⚡ ULTRA FAST URL GRABBER v5.0      ║
║  Port: ${PORT}                          ║  
║  Mode: SPEED OPTIMIZED               ║
║  Target: 3-5 seconds per request     ║
╚═══════════════════════════════════════╝
    `);
    
    console.log('🚀 Initializing browser...');
    await initBrowser();
    console.log('✅ Ready for FAST URL grabbing!');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🔴 Shutting down...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('💥 Unhandled Rejection:', error);
});
