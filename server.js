const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const FLARESOLVERR_URL = 'https://flaresolverr-production-d07b.up.railway.app';

// Cache למניעת בקשות כפולות
const cache = new NodeCache({ stdTTL: 120 });

// ניהול sessions
const activeSessions = new Map();

// ניקוי אוטומטי כל 30 שניות
setInterval(async () => {
  console.log(`🧹 ניקוי... Sessions: ${activeSessions.size}`);
  
  for (const [id, data] of activeSessions) {
    if (Date.now() - data.created > 120000) {
      await destroySession(id);
    }
  }
}, 30000);

async function destroySession(id) {
  try {
    await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'sessions.destroy',
      session: id
    });
    activeSessions.delete(id);
    console.log(`🗑️ Session נמחק: ${id}`);
  } catch (e) {}
}

// Endpoint ראשי
app.post('/v1', async (req, res) => {
  try {
    const { url } = req.body;
    
    // בדוק cache
    if (url) {
      const cached = cache.get(url);
      if (cached) {
        console.log('⚡ מ-Cache!');
        return res.json(cached);
      }
    }
    
    // צור session זמני
    const sessionId = 'temp_' + Date.now();
    
    // צור session
    await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'sessions.create',
      session: sessionId
    });
    
    activeSessions.set(sessionId, { created: Date.now() });
    
    // שלח בקשה
    const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      ...req.body,
      session: sessionId
    });
    
    // שמור ב-cache
    if (url && response.data.status === 'ok') {
      cache.set(url, response.data);
    }
    
    // מחק session מיד
    setTimeout(() => destroySession(sessionId), 1000);
    
    res.json(response.data);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/stats', (req, res) => {
  res.json({
    sessions: activeSessions.size,
    cache: cache.keys().length
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Resource Manager on port ${PORT}`);
});
