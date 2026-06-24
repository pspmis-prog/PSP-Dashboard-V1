const spreadsheetId = '1ip55xEk5rtdqqhCeJ8Hx0IT6aBfnO_0eFIEKh3a7cYg';

async function run() {
  try {
    const query = "SELECT C, Y, AB, AE, AQ LIMIT 200";
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?sheet=FMS&tqx=out:json&tq=${encodeURIComponent(query)}`;
    
    const response = await fetch(url);
    const rawText = await response.text();
    const jsonData = rawText.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
    const parsed = JSON.parse(jsonData);
    
    const rows = parsed.table.rows;
    const stats = { C: new Set(), Y: new Set(), AB: new Set(), AE: new Set(), AQ: new Set() };
    
    rows.forEach((row, rowIdx) => {
      if (rowIdx <= 4) return; // skip headers
      if (row.c[0] && row.c[0].v !== null) stats.C.add(String(row.c[0].v).trim());
      if (row.c[1] && row.c[1].v !== null) stats.Y.add(String(row.c[1].v).trim());
      if (row.c[2] && row.c[2].v !== null) stats.AB.add(String(row.c[2].v).trim());
      if (row.c[3] && row.c[3].v !== null) stats.AE.add(String(row.c[3].v).trim());
      if (row.c[4] && row.c[4].v !== null) stats.AQ.add(String(row.c[4].v).trim());
    });

    console.log("=== DISTINCT STATUS VALUES ===");
    console.log("Col C:", Array.from(stats.C));
    console.log("Col Y:", Array.from(stats.Y));
    console.log("Col AB:", Array.from(stats.AB));
    console.log("Col AE:", Array.from(stats.AE));
    console.log("Col AQ:", Array.from(stats.AQ));

  } catch (error) {
    console.error("Error:", error);
  }
}

run();
