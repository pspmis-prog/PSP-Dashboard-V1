const https = require('https');

function getUrl(url) {
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      getUrl(res.headers.location);
      return;
    }
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      const lines = data.split('\n');
      console.log('Headers:');
      console.log(lines[0]);
      console.log('\nData Rows (first 3):');
      for (let i = 1; i < Math.min(lines.length, 5); i++) {
        console.log(`Row ${i}: ${lines[i]}`);
      }
    });
  }).on('error', (err) => {
    console.error('Error:', err);
  });
}

getUrl('https://script.google.com/macros/s/AKfycbwXqCvFf1s62Kv_Oou0YSYc64xlFzjUBJslnSTqS-AA6n6qU0hP90OXJGJzAn8Pi91VvQ/exec?action=getInspectionKPs&operator=Laxmi');
