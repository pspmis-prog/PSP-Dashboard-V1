const https = require('https');

// NEW spreadsheet
const spreadsheetId = '1ip55xEk5rtdqqhCeJ8Hx0IT6aBfnO_0eFIEKh3a7cYg';

function fetchGViz(query) {
  return new Promise((resolve) => {
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?sheet=FMS&tqx=out:json&tq=${encodeURIComponent(query)}`;
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (redirectRes) => {
          let data = '';
          redirectRes.on('data', chunk => data += chunk);
          redirectRes.on('end', () => resolve(data));
        });
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

async function run() {
  // 1. Get column structure
  const rawHeaders = await fetchGViz("SELECT * LIMIT 0");
  const jsonHeaders = rawHeaders.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
  const parsed = JSON.parse(jsonHeaders);
  
  console.log("=== COLUMN STRUCTURE ===");
  parsed.table.cols.forEach((col, idx) => {
    console.log(`  ${idx}: id=${col.id}, label="${col.label}", type=${col.type}`);
  });
  
  // 2. Get first 10 rows to see data
  const rawData = await fetchGViz("SELECT * LIMIT 10");
  const jsonData = rawData.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
  const parsedData = JSON.parse(jsonData);
  
  console.log("\n=== FIRST 10 ROWS ===");
  parsedData.table.rows.forEach((row, idx) => {
    const vals = row.c.map((cell, colIdx) => {
      if (!cell || cell.v === null || cell.v === undefined) return `${parsed.table.cols[colIdx].id}=null`;
      return `${parsed.table.cols[colIdx].id}="${String(cell.v).substring(0, 40)}"`;
    });
    console.log(`Row ${idx}: ${vals.join(' | ')}`);
  });
}

run();
