const https = require('https');

const spreadsheetId = '1QxYSsFctWoTLdSHL6iVQ9nQYEg0nFVE7IXSNW-t3Ka8';

// GIDs from previous steps
const gids = [
  '1966993124',
  '1833801118',
  '247241437',
  '319308652',
  '663292535',
  '1567856423',
  '265577789',
  '1841862637',
  '1542064604'
];

function fetchCsv(gid) {
  return new Promise((resolve) => {
    let url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
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

function cleanHeader_(h) {
  return String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchesField_(rawH, field) {
  const h = cleanHeader_(rawH);
  switch (field) {
    case "kpnumber":
      return ["kpnumber", "kpno", "jobid", "id", "kp", "jobcardno", "jobcardnumber", "kpnum"].indexOf(h) !== -1;
    case "partname":
      return ["partname", "part", "jcnumber", "jcno", "partdescription", "partname", "materialname", "material"].indexOf(h) !== -1;
    case "customer":
      return ["customer", "customername"].indexOf(h) !== -1;
    case "quantity":
      return ["quantity", "qty"].indexOf(h) !== -1;
    default:
      return h === cleanHeader_(field);
  }
}

async function run() {
  for (const gid of gids) {
    const csv = await fetchCsv(gid);
    const firstLine = csv.split('\n')[0];
    if (!firstLine) continue;
    
    // Parse headers
    const headers = firstLine.split(',').map(h => h.replace(/^"|"$/g, '').trim());
    let kpCol = -1, custCol = -1, partCol = -1, qtyCol = -1;
    headers.forEach((h, idx) => {
      if (matchesField_(h, "kpnumber")) kpCol = idx;
      if (matchesField_(h, "customer")) custCol = idx;
      if (matchesField_(h, "partname")) partCol = idx;
      if (matchesField_(h, "quantity")) qtyCol = idx;
    });
    
    console.log(`\n================================`);
    console.log(`GID: ${gid}`);
    console.log(`Headers: ${headers.slice(0, 15).join(', ')}`);
    console.log(`Matches: kp=${kpCol} (${headers[kpCol] || 'N/A'}), customer=${custCol} (${headers[custCol] || 'N/A'}), part=${partCol} (${headers[partCol] || 'N/A'}), qty=${qtyCol} (${headers[qtyCol] || 'N/A'})`);
  }
}

run();
