const http = require('http');

const testUrl = 'https://partsouq.com';

const options = {
  hostname: 'localhost',
  port: 8080,
  path: '/v1',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  }
};

const data = JSON.stringify({
  cmd: 'request.get',
  url: testUrl,
  maxTimeout: 15000,
  session: 'test_' + Date.now()
});

console.log('🧪 Testing scraper with:', testUrl);

const req = http.request(options, (res) => {
  let body = '';
  
  res.on('data', (chunk) => {
    body += chunk;
  });
  
  res.on('end', () => {
    const response = JSON.parse(body);
    if (response.status === 'ok') {
      console.log('✅ Test passed!');
      console.log('Response length:', response.solution.response.length);
    } else {
      console.log('❌ Test failed:', response.message);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Request failed:', error);
});

req.write(data);
req.end();