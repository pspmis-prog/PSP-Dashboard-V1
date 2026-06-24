const spreadsheetId = '1ip55xEk5rtdqqhCeJ8Hx0IT6aBfnO_0eFIEKh3a7cYg';

async function run() {
  try {
    const query = "SELECT *";
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?sheet=FMS&tqx=out:json&tq=${encodeURIComponent(query)}`;
    
    console.log("Fetching all data to find 'delivered'...");
    const response = await fetch(url);
    const rawText = await response.text();
    const jsonData = rawText.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
    const parsed = JSON.parse(jsonData);
    
    const cols = parsed.table.cols;
    const rows = parsed.table.rows;
    const headerRow = rows[4];
    const headers = headerRow.c.map((cell, idx) => {
      return cell && cell.v !== null && cell.v !== undefined ? String(cell.v).trim() : `Col_${cols[idx].id}`;
    });

    console.log("=== DELIVERED OCCURRENCES ===");
    rows.forEach((row, rowIdx) => {
      if (rowIdx <= 4) return; // skip headers
      row.c.forEach((cell, colIdx) => {
        if (cell && cell.v !== null && cell.v !== undefined) {
          const val = String(cell.v).trim();
          if (val.toLowerCase().includes("delivered")) {
            console.log(`Row ${rowIdx}: Col ${cols[colIdx].id} ("${headers[colIdx]}") contains "${val}"`);
          }
        }
      });
    });

  } catch (error) {
    console.error("Error:", error);
  }
}

run();
