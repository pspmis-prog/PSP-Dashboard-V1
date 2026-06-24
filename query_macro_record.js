const https = require('https');

const scriptUrl = 'https://script.google.com/macros/s/AKfycbxEm6YiO2ZkM9z3JEQludVT6Di99wOKhVREGY6Au31vFGstSpX7WAMuJFoYinVIl46DJg/exec';

function getUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        getUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function run() {
  try {
    const testKp = 'Godrej & Boyce Mfg. Co. Ltd';
    console.log(`Querying getInspectionRecord for kpNo="${testKp}"...`);
    const dataRecord = await getUrl(`${scriptUrl}?action=getInspectionRecord&kpNo=${encodeURIComponent(testKp)}`);
    console.log("Response:");
    console.log(dataRecord);
  } catch (e) {
    console.error("Error:", e);
  }
}

run();
