// App State Variables
let jobs = [];
// Expose jobs on window so iframes (spraying.html) can read via window.parent.jobs
Object.defineProperty(window, 'jobs', {
  get: () => jobs,
  set: (val) => { jobs = val; },
  configurable: true
});
let operators = [];
window.sprayingJobActive = false;
let materials = [];
let auditLogs = [];
let users = [];
let machines = [];
let selectedJobKp = null;
let timerIntervalId = null;
let activeMaskingSubtab = "masking-subtab-queue"; // Default sub-tab
let activeGrindingSubtab = "grinding-subtab-queue"; // Default grinding sub-tab
let activeDmdSubtab = "dmd-subtab-health"; // Default DMD sub-tab
let selectedOperatorName = null; // Operator modal selection state
let selectedShiftName = "A Shift"; // Shift modal selection state
let selectedHoldReason = null; // Hold Reason touch select state
let selectedGrindingJobKp = null; // Grinding active job selection state
let firestoreListeners = []; // Firestore listener unsubscribe handles

// Logged In User State
let currentUser = null;
let pendingSyncCount = 0;
const materialSyncTimers = {};

const scriptUrl = "https://script.google.com/macros/s/AKfycbyaeBzc9wNOuHcU0VLBrsTW8awIwoUXFWpld3jBzGpTdMs26ACyOft-3iAGTBh3M45aPA/exec";
window.scriptUrl = scriptUrl;

// Dynamic Google Sheet Master Data integration for Inspection Stage
let colMapping = {
  kp: null,
  customer: null,
  partName: null,
  quantity: null,
  status: null,
  assignedFirst: null,
  assignedSecond: null,
  timestamp: null
};

function getOperatorCode(email) {
  if (!email) return "";
  const prefix = email.split('@')[0].toLowerCase();
  if (prefix === 'laxmi') return 'Laxmi';
  return prefix.toUpperCase();
}
let activeInspectionRecord = null;

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 1500 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// Configurable cache refresh interval: 10 minutes
const INSPECTION_REFRESH_INTERVAL_MS = 600000;
let lastInspectionFetchTime = 0;

// Inline worker script to parse and filter rows on a background thread
const parserWorkerCode = `
  self.onmessage = function(e) {
    const { rows, op } = e.data;
    try {
      const records = rows.map(row => {
        const cols = row.c || [];
        const kpVal      = cols[0] ? String(cols[0].v || "").trim() : "";
        const customer   = cols[1] ? String(cols[1].v || "").trim() : "";
        const partName   = cols[2] ? String(cols[2].v || "").trim() : "";
        const quantity   = cols[3] ? String(cols[3].v || "").trim() : "";
        const status     = cols[4] ? String(cols[4].v || "").trim() : "";
        const assignedRaw= cols[5] ? String(cols[5].v || "").trim() : "";
        const timestamp  = cols[6] ? String(cols[6].v || "").trim() : "";

        let assignedFirst = "", assignedSecond = "";
        if (assignedRaw) {
          const parts = assignedRaw.split("/").map(s => s.trim());
          assignedFirst  = parts[0] || "";
          assignedSecond = parts[1] || "";
        }

        return { kpNo: kpVal, customer, partName, quantity, status, assignedFirst, assignedSecond, timestamp };
      }).filter(r => r.kpNo && /^kp-/i.test(r.kpNo));

      let filtered = records;
      if (op) {
        const upperOp = op.trim().toUpperCase();
        filtered = records.filter(r => {
          const a1 = String(r.assignedFirst  || "").trim().toUpperCase();
          const a2 = String(r.assignedSecond || "").trim().toUpperCase();
          return a1 === upperOp || a2 === upperOp;
        });
      }
      self.postMessage({ success: true, records: filtered });
    } catch(err) {
      self.postMessage({ success: false, error: err.message });
    }
  };
`;

// Helper: Parse rows using background Worker
function parseRowsWithWorker(rows, op) {
  return new Promise((resolve, reject) => {
    try {
      const blob = new Blob([parserWorkerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);
      
      worker.onmessage = function(e) {
        URL.revokeObjectURL(workerUrl);
        worker.terminate();
        if (e.data.success) {
          resolve(e.data.records);
        } else {
          reject(new Error(e.data.error));
        }
      };
      
      worker.onerror = function(err) {
        URL.revokeObjectURL(workerUrl);
        worker.terminate();
        reject(err);
      };
      
      worker.postMessage({ rows, op });
    } catch(err) {
      reject(err);
    }
  });
}

// Fallback: Chunked main thread parser to prevent UI freeze
async function parseRowsMainThreadAsync(rows, op, chunkSize = 200) {
  return new Promise((resolve) => {
    let index = 0;
    const results = [];
    function nextChunk() {
      const end = Math.min(index + chunkSize, rows.length);
      for (; index < end; index++) {
        const row = rows[index];
        const cols = row.c || [];
        const kpVal      = cols[0] ? String(cols[0].v || "").trim() : "";
        const customer   = cols[1] ? String(cols[1].v || "").trim() : "";
        const partName   = cols[2] ? String(cols[2].v || "").trim() : "";
        const quantity   = cols[3] ? String(cols[3].v || "").trim() : "";
        const status     = cols[4] ? String(cols[4].v || "").trim() : "";
        const assignedRaw= cols[5] ? String(cols[5].v || "").trim() : "";
        const timestamp  = cols[6] ? String(cols[6].v || "").trim() : "";

        let assignedFirst = "", assignedSecond = "";
        if (assignedRaw) {
          const parts = assignedRaw.split("/").map(s => s.trim());
          assignedFirst  = parts[0] || "";
          assignedSecond = parts[1] || "";
        }

        if (kpVal && /^kp-/i.test(kpVal)) {
          let keep = true;
          if (op) {
            const upperOp = op.trim().toUpperCase();
            const a1 = assignedFirst.toUpperCase();
            const a2 = assignedSecond.toUpperCase();
            keep = (a1 === upperOp || a2 === upperOp);
          }
          if (keep) {
            results.push({ kpNo: kpVal, customer, partName, quantity, status, assignedFirst, assignedSecond, timestamp });
          }
        }
      }
      if (index < rows.length) {
        setTimeout(nextChunk, 0);
      } else {
        resolve(results);
      }
    }
    nextChunk();
  });
}

// Check if user is currently interacting with or has inputs in the form
function isUserEditingInspectionForm() {
  const form = document.getElementById("inspection-job-form");
  if (form && form.contains(document.activeElement)) {
    return true;
  }
  const kpVal = document.getElementById("inspect-kp-no")?.value;
  const partVal = document.getElementById("inspect-part-name")?.value;
  const custVal = document.getElementById("inspect-customer")?.value;
  const qtyVal = document.getElementById("inspect-quantity")?.value;
  return !!(kpVal || partVal || custVal || qtyVal);
}

// Controller: Show local loading message & disable inspection inputs
function showInspectionLoading() {
  const loadingEl = document.getElementById("inspection-loading-msg");
  if (loadingEl) loadingEl.style.display = "flex";
  
  const errorEl = document.getElementById("inspection-error-msg");
  if (errorEl) errorEl.style.display = "none";

  const form = document.getElementById("inspection-job-form");
  if (form) {
    form.querySelectorAll("select, input, button:not(#btn-refresh-inspection)").forEach(el => el.disabled = true);
  }
}

// Controller: Hide local loading message & restore inspection inputs
function hideInspectionLoading() {
  const loadingEl = document.getElementById("inspection-loading-msg");
  if (loadingEl) loadingEl.style.display = "none";

  const form = document.getElementById("inspection-job-form");
  if (form) {
    form.querySelectorAll("select, input, button").forEach(el => {
      el.disabled = false;
    });
  }
}

// Unique counter for JSONP callbacks to prevent naming collisions on rapid calls
let _gvizCbCounter = 0;

async function fetchGVizData(queryString) {
  // Use JSONP (script injection) to bypass CORS — no fetch needed
  return new Promise((resolve, reject) => {
    // Use counter + timestamp for guaranteed unique callback names
    const callbackName = '_gvizCb_' + (++_gvizCbCounter) + '_' + Date.now();
    let script;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("GViz JSONP request timed out after 35s"));
    }, 35000);
    
    function cleanup() {
      clearTimeout(timeout);
      // Replace with a self-deleting no-op to prevent late script responses from throwing "not defined" errors
      window[callbackName] = function() {
        try { delete window[callbackName]; } catch(e) {}
      };
      try { if (script && script.parentNode) script.parentNode.removeChild(script); } catch(e) {}
    }
    
    window[callbackName] = function(response) {
      cleanup();
      if (response && response.status === 'error') {
        reject(new Error(response.errors && response.errors[0] ? response.errors[0].detailed_message : "GViz Query Error"));
      } else {
        resolve(response ? response.table : null);
      }
    };
    
    const url = `https://docs.google.com/spreadsheets/d/1ip55xEk5rtdqqhCeJ8Hx0IT6aBfnO_0eFIEKh3a7cYg/gviz/tq?sheet=FMS&range=A5:V3500&tqx=out:json;responseHandler:${callbackName}&tq=${encodeURIComponent(queryString)}`;
    script = document.createElement('script');
    script.src = url;
    script.onerror = () => {
      cleanup();
      reject(new Error("GViz JSONP script load failed"));
    };
    document.head.appendChild(script);
  });
}

function showInspectionError(message) {
  const errorEl = document.getElementById("inspection-error-msg");
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = "block";
  }
  const form = document.getElementById("inspection-job-form");
  if (form) {
    const elements = form.querySelectorAll("input, select, button");
    elements.forEach(el => {
      el.disabled = true;
    });
  }
}

function hideInspectionError() {
  const errorEl = document.getElementById("inspection-error-msg");
  if (errorEl) {
    errorEl.style.display = "none";
  }
  const form = document.getElementById("inspection-job-form");
  if (form) {
    const elements = form.querySelectorAll("input, select, button");
    elements.forEach(el => {
      el.disabled = false;
    });
  }
}

let inspectionMasterRecords = [];
let isUpdatingDropdowns = false;
// Request lock: prevents overlapping inspection data fetches
let _inspectionFetchInProgress = false;
// Retry counter for exponential backoff
let _inspectionRetryCount = 0;
const _INSPECTION_MAX_RETRIES = 3;

function populateInspectionDropdowns() {
  updateInspectionDropdowns();
}

function updateInspectionDropdowns() {
  if (isUpdatingDropdowns) return;
  isUpdatingDropdowns = true;
  
  try {
    const kpSelect = document.getElementById("inspect-kp-no");
    const partSelect = document.getElementById("inspect-part-name");
    const custSelect = document.getElementById("inspect-customer");
    const qtySelect = document.getElementById("inspect-quantity");
    
    if (!kpSelect || !partSelect || !custSelect || !qtySelect) return;
    
    const currentKp = kpSelect.value;
    const currentPart = partSelect.value;
    const currentCust = custSelect.value;
    const currentQty = qtySelect.value;
    
    // Exclude delivered records from all operator dropdowns (case-insensitive)
    const activeRecords = inspectionMasterRecords.filter(r => !r.status || r.status.toLowerCase() !== 'delivered');
    
    // 1. Filter records for KP Number dropdown (based on Part, Customer, Qty filters)
    const kpRecords = activeRecords.filter(r => {
      if (currentPart && r.partName !== currentPart) return false;
      if (currentCust && r.customer !== currentCust) return false;
      if (currentQty && r.quantity !== currentQty) return false;
      return true;
    });
    const validKps = [...new Set(kpRecords.map(r => r.kpNo).filter(Boolean))].sort();
    
    // 2. Filter records for Part Name dropdown (based on KP, Customer, Qty filters)
    const partRecords = activeRecords.filter(r => {
      if (currentKp && r.kpNo !== currentKp) return false;
      if (currentCust && r.customer !== currentCust) return false;
      if (currentQty && r.quantity !== currentQty) return false;
      return true;
    });
    const validParts = [...new Set(partRecords.map(r => r.partName).filter(Boolean))].sort();
    
    // 3. Filter records for Customer Name dropdown (based on KP, Part, Qty filters)
    const custRecords = activeRecords.filter(r => {
      if (currentKp && r.kpNo !== currentKp) return false;
      if (currentPart && r.partName !== currentPart) return false;
      if (currentQty && r.quantity !== currentQty) return false;
      return true;
    });
    const validCusts = [...new Set(custRecords.map(r => r.customer).filter(Boolean))].sort();
    
    // 4. Filter records for Quantity dropdown (based on KP, Part, Customer filters)
    const qtyRecords = activeRecords.filter(r => {
      if (currentKp && r.kpNo !== currentKp) return false;
      if (currentPart && r.partName !== currentPart) return false;
      if (currentCust && r.customer !== currentCust) return false;
      return true;
    });
    const validQtys = [...new Set(qtyRecords.map(r => r.quantity).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
    
    // Populate KP select
    kpSelect.innerHTML = '<option value="">-- Select KP Number --</option>';
    validKps.forEach(kp => {
      const opt = document.createElement("option");
      opt.value = kp;
      opt.textContent = kp;
      kpSelect.appendChild(opt);
    });
    kpSelect.value = validKps.includes(currentKp) ? currentKp : "";
    
    // Populate Part select
    partSelect.innerHTML = '<option value="">-- Select Part Name --</option>';
    validParts.forEach(part => {
      const opt = document.createElement("option");
      opt.value = part;
      opt.textContent = part;
      partSelect.appendChild(opt);
    });
    
    // Populate Customer select
    custSelect.innerHTML = '<option value="">-- Select Customer Name --</option>';
    validCusts.forEach(cust => {
      const opt = document.createElement("option");
      opt.value = cust;
      opt.textContent = cust;
      custSelect.appendChild(opt);
    });
    
    // Populate Quantity select
    qtySelect.innerHTML = '<option value="">-- Select Quantity --</option>';
    validQtys.forEach(qty => {
      const opt = document.createElement("option");
      opt.value = qty;
      opt.textContent = qty;
      qtySelect.appendChild(opt);
    });

    // Auto-select and lock fields if a KP is selected, otherwise leave editable
    if (kpSelect.value) {
      if (validParts.length === 1) partSelect.value = validParts[0];
      if (validCusts.length === 1) custSelect.value = validCusts[0];
      if (validQtys.length === 1) qtySelect.value = validQtys[0];

      partSelect.disabled = true;
      custSelect.disabled = true;
      qtySelect.disabled = true;
    } else {
      partSelect.disabled = false;
      custSelect.disabled = false;
      qtySelect.disabled = false;

      partSelect.value = validParts.includes(currentPart) ? currentPart : "";
      custSelect.value = validCusts.includes(currentCust) ? currentCust : "";
      qtySelect.value = validQtys.includes(currentQty) ? currentQty : "";
    }
    
    // Check if we have a single fully selected match
    const finalMatches = activeRecords.filter(r => 
      r.kpNo === kpSelect.value && 
      r.partName === partSelect.value && 
      r.customer === custSelect.value && 
      r.quantity === qtySelect.value
    );
    
    if (finalMatches.length === 1 && kpSelect.value && partSelect.value && custSelect.value && qtySelect.value) {
      activeInspectionRecord = finalMatches[0];
    } else {
      activeInspectionRecord = null;
    }
  } catch (err) {
    console.error("Error updating inspection dropdowns:", err);
  } finally {
    isUpdatingDropdowns = false;
  }
}

async function loadInspectionKPs(forceRefresh = false, isAutoRefresh = false) {
  // ─── Request Lock: Skip if another fetch is already running ───
  if (_inspectionFetchInProgress) {
    console.log("[Inspection] Fetch already in progress — ignoring concurrent request.");
    return;
  }

  // ─── Cache Check: skip if cache is fresh and we aren't forcing a refresh ───
  const now = Date.now();
  const isCacheFresh = (now - lastInspectionFetchTime) < INSPECTION_REFRESH_INTERVAL_MS;
  if (!forceRefresh && inspectionMasterRecords.length > 0 && isCacheFresh) {
    console.log("[Inspection] Using cached data (freshness: " + Math.round((now - lastInspectionFetchTime) / 1000) + "s)");
    return;
  }

  // ─── Edit guard: skip if user is actively editing the inspection form ───
  if (isAutoRefresh && isUserEditingInspectionForm()) {
    console.log("[Inspection] Auto-refresh skipped — User is currently interacting with the form.");
    return;
  }

  _inspectionFetchInProgress = true;
  showInspectionLoading();

  // ─── Auth state: ensure currentUser is available ───
  const userEmail = currentUser && currentUser.email ? currentUser.email : null;
  const userRole  = currentUser && currentUser.role  ? currentUser.role  : null;
  const isOp      = userRole === 'operator';
  const op        = isOp && userEmail ? getOperatorCode(userEmail) : "";

  console.log("[Inspection] Starting fetch.",
    "User:", userEmail || "(none)",
    "Role:", userRole  || "(none)",
    "Operator:", op || "(admin/all)",
    "Force:", forceRefresh,
    "Auto:", isAutoRefresh
  );

  try {
    // ─── Construct exact-matching SQL Query ───
    let query = "SELECT T, F, I, L, C, V, A WHERE T IS NOT NULL AND (C IS NULL OR LOWER(C) != 'delivered')";
    if (op) {
      const lowerOp = op.trim().toLowerCase();
      query += ` AND (LOWER(V) = '${lowerOp}' OR LOWER(V) LIKE '${lowerOp} /%' OR LOWER(V) LIKE '%/ ${lowerOp}' OR LOWER(V) LIKE '%/ ${lowerOp} /%')`;
    }

    let kpTable = null;
    let lastError = null;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[Inspection] Fetching via GViz (Attempt ${attempt}/${maxAttempts})...`);
        kpTable = await fetchGVizData(query);
        break; // success
      } catch (err) {
        lastError = err;
        console.warn(`[Inspection] Attempt ${attempt} failed: ${err.message}`);
        if (attempt < maxAttempts) {
          const delay = attempt * 1500;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (!kpTable) {
      throw lastError || new Error("Failed to fetch GViz table after retries");
    }

    const rows = kpTable.rows || [];
    console.log("[Inspection] GViz returned", rows.length, "rows.");

    // ─── Parse rows off-main-thread with Web Worker (with Main-Thread fallback) ───
    let parsedRecords = [];
    try {
      parsedRecords = await parseRowsWithWorker(rows, op);
    } catch (workerErr) {
      console.warn("[Inspection] Web Worker parsing failed, using main-thread fallback:", workerErr.message);
      parsedRecords = await parseRowsMainThreadAsync(rows, op);
    }

    // ─── Apply results ───
    inspectionMasterRecords = parsedRecords;
    lastInspectionFetchTime = Date.now();
    _inspectionRetryCount = 0;
    
    console.log("[Inspection] ✅ Data loaded. Records count:", inspectionMasterRecords.length);
    populateInspectionDropdowns();
    hideInspectionLoading();
    hideInspectionError();

  } catch (err) {
    console.error("[Inspection] ❌ Load failed:", err.message);
    if (inspectionMasterRecords.length > 0) {
      console.warn("[Inspection] Retaining " + inspectionMasterRecords.length + " cached records in UI.");
      hideInspectionLoading();
    } else {
      hideInspectionLoading();
      showInspectionError("Inspection data temporarily unavailable. Tap 🔄 Refresh to retry.");
    }
  } finally {
    _inspectionFetchInProgress = false;
  }
}

function isMockMode() {
  return typeof firebaseConfig === 'undefined' || !firebaseConfig.apiKey || firebaseConfig.apiKey.includes("YOUR_FIREBASE_") || localStorage.getItem("psp_auth_mock") === "true";
}

function loadFirebaseSDKs(callback) {
  if (isMockMode()) {
    callback();
    return;
  }
  
  if (typeof firebase !== 'undefined') {
    callback();
    return;
  }
  
  const sApp = document.createElement("script");
  sApp.src = "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js";
  sApp.onload = () => {
    const sAuth = document.createElement("script");
    sAuth.src = "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js";
    sAuth.onload = () => {
      const sStore = document.createElement("script");
      sStore.src = "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js";
      sStore.onload = () => {
        if (!firebase.apps.length) {
          firebase.initializeApp(firebaseConfig);
        }
        callback();
      };
      document.head.appendChild(sStore);
    };
    document.head.appendChild(sAuth);
  };
  sApp.onerror = () => {
    console.warn("Firebase CDN failed to load in app. Falling back to local Mock Mode.");
    localStorage.setItem("psp_auth_mock", "true");
    callback();
  };
  document.head.appendChild(sApp);
}

// Local database management for Mock Users
const MOCK_DB = {
  getUsers() {
    return JSON.parse(localStorage.getItem('mock_db_users') || '[]');
  },
  saveUsers(users) {
    localStorage.setItem('mock_db_users', JSON.stringify(users));
  },
  addUser(user, password) {
    const users = this.getUsers();
    users.push(user);
    this.saveUsers(users);
    
    const passwords = JSON.parse(localStorage.getItem('mock_db_passwords') || '{}');
    passwords[user.email] = password;
    localStorage.setItem('mock_db_passwords', JSON.stringify(passwords));
  }
};

async function syncMaskingQueueFromBackend() {
  try {
    const response = await fetch(scriptUrl + "?process=MASKING");
    if (!response.ok) throw new Error("HTTP error " + response.status);
    const backendJobs = await response.json();
    console.log("Fetched masking queue from backend:", backendJobs);
    
    let updated = false;
    backendJobs.forEach(bj => {
      let localJob = jobs.find(j => j.kpNumber === bj.kpNo);
      if (localJob) {
        if (!localJob.rowIndex) {
          localJob.rowIndex = bj.rowIndex;
          updated = true;
        }
      } else {
        // Add new job from backend
        const newJob = {
          kpNumber: bj.kpNo,
          partName: bj.materialName || "Unknown Part",
          customer: bj.customerName || "Unknown Customer",
          quantity: Number(bj.qty) || 1,
          processType: bj.jcNo || "Plasma",
          priority: "Normal",
          inspectionDate: new Date().toISOString().split('T')[0],
          receivedDate: new Date().toISOString().split('T')[0],
          currentDepartment: "Masking",
          status: "Pending",
          rowIndex: bj.rowIndex,
          masking: {
            operatorName: "",
            shift: "",
            status: "Pending",
            startTime: null,
            endTime: null,
            durationMs: 0,
            activeTimeMs: 0,
            lastStartedAt: null,
            lastPausedAt: null,
            holdHistory: [],
            materials: []
          },
          spraying: { status: "Pending" },
          grinding: { status: "Pending" },
          polishing: { status: "Pending" },
          finalInspection: { status: "Pending" },
          dispatch: { status: "Pending" }
        };
        jobs.push(newJob);
        updated = true;
      }
    });

    if (updated) {
      saveState();
      renderAll();
    }
  } catch (err) {
    console.warn("Could not sync masking queue from backend (offline?):", err);
  }
}

async function syncMaskingJobToBackend(job, nextDept) {
  if (!job.rowIndex) {
    console.warn("No rowIndex found for job", job.kpNumber, "- cannot update Google Sheets.");
    return;
  }
  
  try {
    const payload = {
      type: "SAVE_MASKING_JOB",
      rowIndex: job.rowIndex,
      kpNo: job.kpNumber,
      qty: job.quantity,
      doerQty: job.quantity,
      startTime: job.masking.startTime,
      endTime: job.masking.endTime,
      nextProcess: nextDept || "Spraying",
      operatorName: job.masking.operatorName || "System"
    };

    console.log("Sending SAVE_MASKING_JOB to backend:", payload);
    const response = await fetch(scriptUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain"
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) throw new Error("HTTP error " + response.status);
    const result = await response.json();
    console.log("Saved masking job response from backend:", result);
    
    // Refresh spraying iframe if active
    const sprayingIframe = document.getElementById("spraying-iframe");
    if (sprayingIframe && sprayingIframe.contentWindow) {
      sprayingIframe.contentWindow.dispatchEvent(new CustomEvent("refresh-spraying-data"));
    }
  } catch (err) {
    console.error("Failed to sync completed masking job to backend:", err);
  }
}

// DOM Elements
const clockElement = document.getElementById("header-clock");
const shiftSelect = document.getElementById("header-shift-select");

// Sidebar Badges
const badgeInspection = document.getElementById("badge-count-inspection");
const badgeMasking = document.getElementById("badge-count-masking");
const badgeSpraying = document.getElementById("badge-count-spraying");

// TAB panes & navigation
const navButtons = document.querySelectorAll(".nav-btn");
const tabPanes = document.querySelectorAll(".tab-pane");

// Initialize application
window.addEventListener("DOMContentLoaded", () => {
  initApp();
});

// Role to Menu Mappings
// Role to Menu Mappings
const ROLE_PERMISSIONS = {
  super_admin: [
    'tab-overview', 'tab-inspection', 'tab-masking', 'tab-spraying', 
    'tab-grinding', 'tab-polishing', 'tab-final-inspection', 'tab-dispatch', 
    'tab-audit-logs', 'tab-user-management', 'tab-data-management'
  ],
  production_admin: [
    'tab-overview', 'tab-inspection', 'tab-masking', 'tab-spraying', 
    'tab-grinding', 'tab-polishing', 'tab-final-inspection', 'tab-dispatch', 'tab-data-management'
  ],
  it_team: [
    'tab-overview', 'tab-data-management'
  ],
  hr_admin: [
    'tab-overview', 'tab-inspection', 'tab-masking', 'tab-spraying', 
    'tab-grinding', 'tab-polishing', 'tab-final-inspection', 'tab-dispatch'
  ],
  quality_admin: [
    'tab-overview', 'tab-inspection', 'tab-final-inspection'
  ],
  operator: {
    Masking: ['tab-masking'],
    Spraying: ['tab-spraying'],
    Grinding: ['tab-grinding'],
    Polishing: ['tab-polishing'],
    Inspection: ['tab-inspection']
  }
};

function getCleanDeptKey(dept) {
  if (!dept) return "";
  const d = dept.toLowerCase().trim();
  if (d.includes("mask")) return "Masking";
  if (d.includes("spray")) return "Spraying";
  if (d.includes("grind")) return "Grinding";
  if (d.includes("polish")) return "Polishing";
  if (d.includes("inspect")) return "Inspection";
  return dept;
}

function isTabAuthorized(tabId) {
  if (!currentUser) return false;
  const role = currentUser.role;
  if (role === 'super_admin') return ROLE_PERMISSIONS.super_admin.includes(tabId);
  if (role === 'production_admin') return ROLE_PERMISSIONS.production_admin.includes(tabId);
  if (role === 'it_team') return ROLE_PERMISSIONS.it_team.includes(tabId);
  if (role === 'hr_admin') return ROLE_PERMISSIONS.hr_admin.includes(tabId);
  if (role === 'quality_admin') return ROLE_PERMISSIONS.quality_admin.includes(tabId);
  if (role === 'operator') {
    const dept = getCleanDeptKey(currentUser.department);
    const allowed = ROLE_PERMISSIONS.operator[dept] || [];
    return allowed.includes(tabId);
  }
  return false;
}

function getDefaultTab() {
  if (!currentUser) return 'tab-masking';
  const role = currentUser.role;
  if (role === 'it_team') return 'tab-data-management';
  if (role === 'operator') {
    const dept = getCleanDeptKey(currentUser.department);
    if (dept === 'Masking') return 'tab-masking';
    if (dept === 'Spraying') return 'tab-spraying';
    if (dept === 'Grinding') return 'tab-grinding';
    if (dept === 'Polishing') return 'tab-polishing';
    if (dept === 'Inspection') return 'tab-inspection';
  }
  if (role === 'quality_admin') return 'tab-inspection';
  return 'tab-overview';
}

async function initApp() {
  // 1. Session check
  const userStr = localStorage.getItem("psp_logged_in_user");
  if (!userStr) {
    window.location.href = "login.html";
    return;
  }
  try {
    currentUser = JSON.parse(userStr);
    if (!currentUser || !currentUser.active) {
      localStorage.removeItem("psp_logged_in_user");
      window.location.href = "login.html";
      return;
    }
  } catch (e) {
    localStorage.removeItem("psp_logged_in_user");
    window.location.href = "login.html";
    return;
  }

  // Set up permissions and initial routing IMMEDIATELY to prevent UI flicker
  initTheme();
  startClock();
  setupNav();
  setupMaskingSubtabs();
  setupGrindingSubtabs();
  setupHamburger();
  populateHeaderUser();
  applySidebarPermissions();
  
  // Set up Hash Router triggers
  window.addEventListener("hashchange", handleRouting);
  // Run initial routing on startup (silently redirecting to authorized default)
  handleRouting(true);
  
  // Set up unload handler to prevent navigating away if spraying job is active
  window.addEventListener("beforeunload", (e) => {
    if (window.sprayingJobActive) {
      e.preventDefault();
      e.returnValue = "A Spraying job is currently active. Are you sure you want to exit?";
      return e.returnValue;
    }
  });

  // Setup fullscreen handler for Spraying Operator
  if (currentUser && currentUser.role === 'operator' && getCleanDeptKey(currentUser.department) === 'Spraying') {
    const enterFullscreen = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
          console.warn("Fullscreen request blocked or failed:", err);
        });
      }
    };
    // Enter fullscreen on first user interaction
    document.addEventListener("click", enterFullscreen, { once: true });
    document.addEventListener("touchstart", enterFullscreen, { once: true });

    // Re-request fullscreen on interaction if they exit it while a job is running
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && window.sprayingJobActive) {
        alert("Fullscreen is required while a Spraying job is in progress!");
        document.addEventListener("click", enterFullscreen, { once: true });
        document.addEventListener("touchstart", enterFullscreen, { once: true });
      }
    });
  }
  
  // Load Firebase SDKs first, then start Firestore listeners (if not mock mode) and load initial state
  loadFirebaseSDKs(async () => {
    if (!isMockMode()) {
      firebase.auth().onAuthStateChanged(async (user) => {
        if (user) {
          console.log("Firebase user session authenticated:", user.email);
          startFirestoreListeners();
          // Auto seed db if empty (requires super_admin check inside function)
          setTimeout(seedFirestoreDatabaseIfEmpty, 2000);
        } else {
          console.warn("Firebase Auth state: no active user session. Redirecting to login...");
          window.location.href = "login.html";
        }
      });
    } else {
      // Offline / Mock fallback
      await loadState();
    }
    
    // Fetch Google Sheet master data on startup asynchronously (non-blocking)
    setTimeout(() => {
      loadInspectionKPs(false, false).catch(e => console.error("[Inspection] Initial load error:", e));
    }, 300);
    renderAll();
    
    startStateTimer();
    setupEventListeners();
    setupDmdEventListeners(); // Setup DMD dynamic subtab events
    startAutoRefresh();

    // Live update: Poll Google Sheet for new KP numbers periodically (configured to 10 minutes)
    // Guard prevents overlapping requests via _inspectionFetchInProgress lock and skips if user is editing
    setInterval(async () => {
      try {
        await loadInspectionKPs(false, true);
        console.log("[Inspection] Auto-refresh check complete.");
      } catch (err) {
        console.warn("[Inspection] Auto-refresh failed:", err.message);
      }
    }, INSPECTION_REFRESH_INTERVAL_MS);
  });
}


function initTheme() {
  const currentTheme = localStorage.getItem("mes_theme") || "dark";
  const icon = document.getElementById("theme-toggle-icon");
  const text = document.getElementById("theme-toggle-text");
  
  if (currentTheme === "light") {
    document.body.classList.add("light-theme");
    if (icon) icon.textContent = "🌙";
    if (text) text.textContent = "DARK";
  } else {
    document.body.classList.remove("light-theme");
    if (icon) icon.textContent = "☀️";
    if (text) text.textContent = "LIGHT";
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle("light-theme");
  localStorage.setItem("mes_theme", isLight ? "light" : "dark");
  initTheme();
  createAuditLog("System", null, `Theme mode switched to ${isLight ? 'Light Mode' : 'Dark Mode'}`);
}

// 1. STATE & STORAGE MANAGEMENT
// 1. STATE & STORAGE MANAGEMENT & FIRESTORE EVENT STREAM

async function sendBackendPost(payload) {
  const isMock = isMockMode();
  if (isMock) {
    console.log("Mock Mode POST:", payload);
    return { success: true };
  }
  
  try {
    const db = firebase.firestore();
    const reqType = String(payload.type || payload.action || "").trim().toUpperCase();
    
    let jobRef = null;
    let jobData = null;
    if (payload.kpNo && payload.kpNo !== "N/A") {
      const snap = await db.collection("jobs").where("kpNumber", "==", payload.kpNo).get();
      if (!snap.empty) {
        jobRef = snap.docs[0].ref;
        jobData = snap.docs[0].data();
      }
    }
    
    // 1. START CYCLE
    if (reqType === "START_CYCLE" || reqType === "STARTCYCLE") {
      if (!jobRef) throw new Error(`Job ${payload.kpNo} not found`);
      
      const stageKey = payload.stage.toLowerCase().replace(/[^a-z]/g, "");
      const stageData = jobData[stageKey] || {};
      
      stageData.status = "In Progress";
      stageData.operatorName = payload.operatorName || "";
      stageData.shift = payload.shift || "";
      stageData.startTime = payload.startTime || new Date().toISOString();
      stageData.lastStartedAt = payload.startTime || new Date().toISOString();
      stageData.holdHistory = payload.holdHistory || [];
      
      await jobRef.update({
        currentStatus: "In Progress",
        assignedOperator: { uid: currentUser?.uid || "", name: payload.operatorName || "" },
        shift: payload.shift || "",
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        [stageKey]: stageData
      });
      
      await createFirestoreAuditLog(payload.operatorName, payload.stage, payload.kpNo, "Cycle Started", `Commenced ${payload.stage} process on ${payload.shift || "A Shift"}`);
      return { success: true };
    }
    
    // 2. PAUSE CYCLE
    if (reqType === "PAUSE_CYCLE" || reqType === "PAUSECYCLE") {
      if (!jobRef) throw new Error(`Job ${payload.kpNo} not found`);
      
      const stageKey = payload.stage.toLowerCase().replace(/[^a-z]/g, "");
      const stageData = jobData[stageKey] || {};
      
      stageData.status = "Hold";
      stageData.activeTimeMs = Number(payload.activeTimeMs || 0);
      stageData.holdHistory = payload.holdHistory || [];
      stageData.lastPausedAt = new Date().toISOString();
      if (payload.holdReason) {
        stageData.remarks = payload.remarks || "";
        stageData.holdReason = payload.holdReason;
      }
      
      await jobRef.update({
        currentStatus: "Hold",
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        [stageKey]: stageData
      });
      
      await createFirestoreAuditLog(payload.operatorName, payload.stage, payload.kpNo, "Cycle Paused", `Put on Hold (Reason: ${payload.holdReason || "N/A"}. Remarks: ${payload.remarks || ""})`);
      return { success: true };
    }
    
    // 3. RESUME CYCLE
    if (reqType === "RESUME_CYCLE" || reqType === "RESUMECYCLE") {
      if (!jobRef) throw new Error(`Job ${payload.kpNo} not found`);
      
      const stageKey = payload.stage.toLowerCase().replace(/[^a-z]/g, "");
      const stageData = jobData[stageKey] || {};
      
      stageData.status = "In Progress";
      stageData.holdHistory = payload.holdHistory || [];
      stageData.lastStartedAt = new Date().toISOString();
      
      await jobRef.update({
        currentStatus: "In Progress",
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        [stageKey]: stageData
      });
      
      await createFirestoreAuditLog(payload.operatorName, payload.stage, payload.kpNo, "Cycle Resumed", "Job returned to active state");
      return { success: true };
    }
    
    // 4. END CYCLE
    if (reqType === "END_CYCLE" || reqType === "ENDCYCLE") {
      if (!jobRef) throw new Error(`Job ${payload.kpNo} not found`);
      
      const stageKey = payload.stage.toLowerCase().replace(/[^a-z]/g, "");
      const stageData = jobData[stageKey] || {};
      
      stageData.status = "Completed";
      stageData.endTime = payload.endTime || new Date().toISOString();
      stageData.activeTimeMs = Number(payload.activeTimeMs || 0);
      stageData.holdHistory = payload.holdHistory || [];
      
      // Store additional spraying metadata if present
      if (payload.batchId !== undefined) stageData.batchId = payload.batchId;
      if (payload.processedQty !== undefined) stageData.processedQty = Number(payload.processedQty);
      if (payload.totalPasses !== undefined) stageData.totalPasses = Number(payload.totalPasses);
      if (payload.finalTemp !== undefined) stageData.finalTemp = payload.finalTemp;
      if (payload.finalThickness !== undefined) stageData.finalThickness = payload.finalThickness;
      if (payload.finalSize !== undefined) stageData.finalSize = payload.finalSize;
      if (payload.powderConsumed !== undefined) stageData.powderConsumed = payload.powderConsumed;
      if (payload.location !== undefined) stageData.location = payload.location;
      
      const nextStage = payload.nextStage || "Spraying";
      const nextStageKey = nextStage.toLowerCase().replace(/[^a-z]/g, "");
      
      const updates = {
        currentStage: nextStage,
        currentStatus: nextStage === "Dispatched" ? "Completed" : "Pending",
        assignedOperator: null,
        shift: "",
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        [stageKey]: stageData
      };
      
      if (nextStage !== "Dispatched") {
        const nextStageData = jobData[nextStageKey] || { status: "Pending" };
        nextStageData.status = "Pending";
        updates[nextStageKey] = nextStageData;
      }
      
      await jobRef.update(updates);
      
      await createFirestoreAuditLog(payload.operatorName, payload.stage, payload.kpNo, "Cycle Ended", `Completed ${payload.stage} process, routed to ${nextStage}`);
      
      await db.collection("notifications").add({
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        message: `Job ${payload.kpNo} completed stage ${payload.stage} and moved to ${nextStage}`,
        type: "info",
        read: false
      });
      
      return { success: true };
    }
    
    // 5. ADD MATERIAL CONSUMPTION
    if (reqType === "ADD_MATERIAL_CONSUMPTION" || reqType === "ADDMATERIALCONSUMPTION") {
      if (!jobRef) throw new Error(`Job ${payload.kpNo} not found`);
      
      const mcDoc = db.collection("jobs").doc(jobRef.id).collection("material_consumption").doc();
      await mcDoc.set({
        consumptionId: mcDoc.id,
        stage: payload.stage,
        materialName: payload.materialName,
        category: payload.materialType || "",
        batchNumber: payload.batch || "",
        plannedQty: Number(payload.plannedQty || 0),
        actualQty: Number(payload.actualQty || 0),
        unit: payload.unit || "",
        operator: { uid: currentUser?.uid || "", name: payload.operatorName },
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
      
      const masking = jobData.masking || { materials: [] };
      masking.materials = masking.materials || [];
      const matIdx = masking.materials.findIndex(m => m.name === payload.materialName);
      const newMat = {
        name: payload.materialName,
        type: payload.materialType || "",
        batch: payload.batch || "",
        unit: payload.unit || "",
        plannedQty: Number(payload.plannedQty || 0),
        actualQty: Number(payload.actualQty || 0)
      };
      if (matIdx !== -1) {
        masking.materials[matIdx] = newMat;
      } else {
        masking.materials.push(newMat);
      }
      
      await jobRef.update({
        masking: masking,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      });
      
      await createFirestoreAuditLog(payload.operatorName, payload.stage, payload.kpNo, "Material Synced", `Logged material consumption ${payload.materialName} (Actual: ${payload.actualQty})`);
      return { success: true };
    }
    
    // 6. DELETE MATERIAL CONSUMPTION
    if (reqType === "DELETE_MATERIAL_CONSUMPTION" || reqType === "DELETEMATERIALCONSUMPTION") {
      if (!jobRef) throw new Error(`Job ${payload.kpNo} not found`);
      
      const mcSnap = await db.collection("jobs").doc(jobRef.id).collection("material_consumption")
        .where("materialName", "==", payload.materialName)
        .where("stage", "==", payload.stage).get();
      
      const batch = db.batch();
      mcSnap.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      
      const masking = jobData.masking || { materials: [] };
      masking.materials = masking.materials || [];
      masking.materials = masking.materials.filter(m => m.name !== payload.materialName);
      
      await jobRef.update({
        masking: masking,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      });
      
      await createFirestoreAuditLog(payload.operatorName, payload.stage, payload.kpNo, "Material Removed", `Removed material ${payload.materialName}`);
      return { success: true };
    }
    
    // 7. CREATE AUDIT LOG
    if (reqType === "CREATE_AUDIT_LOG" || reqType === "CREATEAUDITLOG") {
      await createFirestoreAuditLog(payload.user, payload.department, payload.kpNo, "Event", payload.action);
      return { success: true };
    }
    
    // 8. CREATE JOB
    if (reqType === "CREATE_JOB" || reqType === "CREATEJOB") {
      const jobId = `job_${payload.kpNo || Math.floor(100000 + Math.random() * 900000)}`;
      await db.collection("jobs").doc(jobId).set({
        jobId: jobId,
        kpNumber: payload.kpNo,
        partName: payload.partName,
        customer: payload.customer,
        quantity: Number(payload.quantity || 1),
        processType: payload.processType || "Plasma",
        priority: payload.priority || "Normal",
        currentStage: payload.currentDepartment || "Inspection",
        currentStatus: payload.status || "Inspection Pending",
        storeLocation: payload.storeLocation || "",
        createdDate: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: currentUser?.email || "System",
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        masking: { status: "Pending", materials: [], holdHistory: [] },
        spraying: { status: "Pending" },
        grinding: { status: "Pending", holdHistory: [] },
        polishing: { status: "Pending" },
        finalInspection: { status: "Pending" },
        dispatch: { status: "Pending" }
      });
      
      await createFirestoreAuditLog(currentUser?.email || "System", "Inspection", payload.kpNo, "Job Registered", `Registered new component ${payload.partName}`);
      return { success: true };
    }

    // 9. UPDATE JOB LOCATION
    if (reqType === "UPDATE_JOB_LOCATION") {
      if (!jobRef) throw new Error(`Job ${payload.kpNo} not found`);
      await jobRef.update({
        storeLocation: payload.location,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      });
      await createFirestoreAuditLog(currentUser?.email || "System", "Spraying", payload.kpNo, "Location Updated", `Updated store location to ${payload.location}`);
      return { success: true };
    }
    
    throw new Error(`Unhandled transaction type: ${reqType}`);
  } catch (err) {
    console.error("Firestore post sync error:", err);
    logErrorToFirestore("sendBackendPost", err);
    throw err;
  }
}

async function createFirestoreAuditLog(userEmail, department, kpNumber, action, details) {
  const isMock = isMockMode();
  if (isMock) return;
  
  try {
    const db = firebase.firestore();
    let userId = "system";
    let userRole = "System";
    if (currentUser) {
      userId = currentUser.uid || "system";
      userRole = currentUser.role || "Operator";
    }
    
    await db.collection("audit_logs").add({
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      userId: userId,
      userEmail: userEmail || currentUser?.email || "System",
      role: userRole,
      department: department || "System",
      kpNumber: kpNumber || "N/A",
      action: action,
      details: details || `${userRole.toUpperCase()} action: ${action}`
    });
  } catch (err) {
    console.error("Failed to write firestore audit log:", err);
  }
}

function logErrorToFirestore(action, error) {
  if (isMockMode()) {
    console.warn("Mock Mode: Error logged:", action, error);
    return;
  }
  try {
    const db = firebase.firestore();
    db.collection("error_logs").add({
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      userId: currentUser ? currentUser.uid : "unknown",
      path: window.location.hash || "app.js",
      errorMessage: error.message || String(error),
      stackTrace: error.stack || ""
    });
  } catch(e) {
    console.error("Failed to write error log to firestore:", e);
  }
}

function startFirestoreListeners() {
  if (isMockMode()) return;
  
  try {
    const db = firebase.firestore();
    
    firestoreListeners.forEach(unsub => {
      try { unsub(); } catch(e) {}
    });
    firestoreListeners = [];
    
    // 1. Listen to jobs
    const unsubJobs = db.collection("jobs").onSnapshot(snapshot => {
      let tempJobs = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        const job = {
          jobId: data.jobId || doc.id,
          kpNumber: data.kpNumber,
          partName: data.partName || "Unknown Part",
          customer: data.customer || "Unknown Customer",
          quantity: Number(data.quantity || 1),
          processType: data.processType || "Plasma",
          priority: data.priority || "Normal",
          currentDepartment: data.currentStage || "Inspection",
          status: data.currentStatus || "Pending",
          operatorName: data.assignedOperator?.name || "",
          shift: data.shift || "",
          storeLocation: data.storeLocation || "",
          masking: data.masking || { status: "Pending", materials: [], holdHistory: [] },
          spraying: data.spraying || { status: "Pending" },
          grinding: data.grinding || { status: "Pending", holdHistory: [] },
          polishing: data.polishing || { status: "Pending" },
          finalInspection: data.finalInspection || { status: "Pending" },
          dispatch: data.dispatch || { status: "Pending" }
        };
        tempJobs.push(job);
      });
      
      jobs = tempJobs;
      renderAll();
    }, err => {
      console.error("Jobs listener error:", err);
      logErrorToFirestore("jobs-listener", err);
    });
    firestoreListeners.push(unsubJobs);
    
    // 2. Listen to users
    const unsubUsers = db.collection("users").onSnapshot(snapshot => {
      let tempUsers = [];
      let tempOperators = [];
      snapshot.forEach(doc => {
        const u = doc.data();
        tempUsers.push(u);
        if (u.role === 'operator') {
          tempOperators.push({
            id: u.uid || doc.id,
            name: (u.name && u.name.trim() !== "") ? u.name : (u.email ? u.email.split('@')[0] : "Operator"),
            shift: u.shift || "A Shift",
            jobsAssigned: Number(u.jobsAssigned || 0),
            jobsCompleted: Number(u.jobsCompleted || 0),
            activeTimeMs: Number(u.activeTimeMs || 0)
          });
        }
      });
      users = tempUsers;
      if (tempOperators.length > 0) {
        operators = tempOperators;
      }
      renderAll();
    }, err => {
      console.error("Users listener error:", err);
    });
    firestoreListeners.push(unsubUsers);
    
    // 3. Listen to machines
    const unsubMachines = db.collection("machines").onSnapshot(snapshot => {
      let tempMachines = [];
      snapshot.forEach(doc => {
        tempMachines.push(doc.data());
      });
      machines = tempMachines;
      renderAll();
    }, err => {
      console.error("Machines listener error:", err);
    });
    firestoreListeners.push(unsubMachines);
    
    // 4. Listen to master_materials
    const unsubMaterials = db.collection("master_materials").onSnapshot(snapshot => {
      let tempMaterials = [];
      snapshot.forEach(doc => {
        tempMaterials.push(doc.data());
      });
      materials = tempMaterials;
      renderAll();
    }, err => {
      console.error("Materials listener error:", err);
    });
    firestoreListeners.push(unsubMaterials);
    
    // 5. Listen to audit_logs (only if role is admin/IT/quality/hr)
    const userRole = currentUser ? currentUser.role : "";
    const isDmdAuthorized = userRole === 'super_admin' || userRole === 'production_admin' || userRole === 'it_team';
    
    if (isDmdAuthorized || userRole === 'quality_admin' || userRole === 'hr_admin') {
      const unsubAudit = db.collection("audit_logs").orderBy("timestamp", "desc").limit(50).onSnapshot(snapshot => {
        let tempAudit = [];
        snapshot.forEach(doc => {
          const data = doc.data();
          tempAudit.push({
            timestamp: data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : (data.timestamp || new Date().toISOString()),
            user: data.userEmail || data.user || "System",
            role: data.role || "Operator",
            department: data.department || "Masking",
            kpNumber: data.kpNumber || "N/A",
            action: data.action || data.details || "Event"
          });
        });
        auditLogs = tempAudit;
        renderAll();
      }, err => {
        console.error("Audit logs listener error:", err);
      });
      firestoreListeners.push(unsubAudit);
    }
    
    // 6. Listen to departments
    const unsubDepts = db.collection("departments").orderBy("sequence", "asc").onSnapshot(snapshot => {
      let tempDepts = [];
      snapshot.forEach(doc => {
        tempDepts.push(doc.data());
      });
      window.departmentsList = tempDepts;
      renderAll();
    }, err => {
      console.error("Departments listener error:", err);
    });
    firestoreListeners.push(unsubDepts);
    
    // 7. Listen to system_monitoring (only if IT / Admin)
    if (isDmdAuthorized) {
      const unsubSys = db.collection("system_monitoring").onSnapshot(snapshot => {
        let tempSys = {};
        snapshot.forEach(doc => {
          tempSys[doc.id] = doc.data();
        });
        window.systemMonitoringData = tempSys;
        renderAll();
      }, err => {
        console.error("System monitoring listener error:", err);
      });
      firestoreListeners.push(unsubSys);
    }
    
    // 8. Listen to error_logs (only if IT / Admin)
    if (isDmdAuthorized) {
      const unsubErr = db.collection("error_logs").orderBy("timestamp", "desc").limit(50).onSnapshot(snapshot => {
        let tempErr = [];
        snapshot.forEach(doc => {
          tempErr.push(doc.data());
        });
        window.errorLogsData = tempErr;
        renderAll();
      }, err => {
        console.error("Error logs listener error:", err);
      });
      firestoreListeners.push(unsubErr);
    }

    // 9. Listen to notifications
    const unsubNotifications = db.collection("notifications").orderBy("timestamp", "desc").limit(20).onSnapshot(snapshot => {
      let tempNotifications = [];
      snapshot.forEach(doc => {
        tempNotifications.push(doc.data());
      });
      window.notificationsData = tempNotifications;
      renderAll();
    }, err => {
      console.error("Notifications listener error:", err);
    });
    firestoreListeners.push(unsubNotifications);
    
  } catch (err) {
    console.error("Error initializing Firestore listeners:", err);
  }
}

async function seedFirestoreDatabaseIfEmpty() {
  if (isMockMode()) return;
  try {
    const db = firebase.firestore();
    
    const deptsSnap = await db.collection("departments").limit(1).get();
    if (deptsSnap.empty) {
      console.log("Seeding departments Master database in Firestore...");
      const depts = [
        { name: "Inspection", sequence: 1, allowedStoreLocations: ["A1", "A2", "A3"], allowedPauseReasons: ["Quality Issue", "Other"] },
        { name: "Masking", sequence: 2, allowedStoreLocations: ["M1", "M2", "M3"], allowedPauseReasons: ["Material Shortage", "Operator Unavailable", "Other"] },
        { name: "Spraying", sequence: 3, allowedStoreLocations: ["S1", "S2", "S3"], allowedPauseReasons: ["Machine Issue", "Quality Issue", "Other"] },
        { name: "Grinding", sequence: 4, allowedStoreLocations: ["C20", "B27", "A15", "D08"], allowedPauseReasons: ["Material Shortage", "Operator Unavailable", "Machine Issue", "Quality Issue", "Other"] },
        { name: "Polishing", sequence: 5, allowedStoreLocations: ["P1", "P2"], allowedPauseReasons: ["Machine Issue", "Other"] },
        { name: "Final Inspection", sequence: 6, allowedStoreLocations: ["F1", "F2"], allowedPauseReasons: ["Quality Issue", "Other"] },
        { name: "Dispatch", sequence: 7, allowedStoreLocations: ["D1", "D2"], allowedPauseReasons: ["Customer Hold", "Other"] }
      ];
      const batch = db.batch();
      depts.forEach(d => {
        const ref = db.collection("departments").doc(d.name);
        batch.set(ref, d);
      });
      await batch.commit();
    }
    
    const matsSnap = await db.collection("master_materials").limit(1).get();
    if (matsSnap.empty) {
      console.log("Seeding master materials database in Firestore...");
      const batch = db.batch();
      SEED_MATERIALS.forEach(m => {
        const ref = db.collection("master_materials").doc(m.name.toLowerCase().replace(/[^a-z0-9]/g, "_"));
        batch.set(ref, {
          materialId: m.id || m.name.toLowerCase().replace(/[^a-z0-9]/g, "_"),
          name: m.name,
          category: m.type || "Consumable",
          unit: m.unit || "KG",
          department: "Masking",
          isActive: true
        });
      });
      await batch.commit();
    }
    
    const machsSnap = await db.collection("machines").limit(1).get();
    if (machsSnap.empty) {
      console.log("Seeding machines database in Firestore...");
      const machs = [
        { machineId: "hmt_g17", name: "HMT G17", type: "Grinding Machine", department: "Grinding", status: "idle", lastMaintenance: firebase.firestore.FieldValue.serverTimestamp() },
        { machineId: "amba", name: "Amba", type: "Grinding Machine", department: "Grinding", status: "idle", lastMaintenance: firebase.firestore.FieldValue.serverTimestamp() },
        { machineId: "kirloskar", name: "Kirloskar", type: "Grinding Machine", department: "Grinding", status: "idle", lastMaintenance: firebase.firestore.FieldValue.serverTimestamp() }
      ];
      const batch = db.batch();
      machs.forEach(m => {
        const ref = db.collection("machines").doc(m.machineId);
        batch.set(ref, m);
      });
      await batch.commit();
    }
  } catch (err) {
    console.error("Firestore DB seeding error:", err);
  }
}

async function loadState() {
  if (!isMockMode()) {
    return;
  }
  try {
    const [jobsRes, operatorsRes, materialsRes, auditLogsRes] = await Promise.all([
      fetch(scriptUrl + "?action=getJobs").then(r => r.json()),
      fetch(scriptUrl + "?action=getOperators").then(r => r.json()),
      fetch(scriptUrl + "?action=getMaterials").then(r => r.json()),
      fetch(scriptUrl + "?action=getAuditLogs").then(r => r.json())
    ]);

    console.log("RAW JOBS RES:", JSON.stringify(jobsRes));

    if (Array.isArray(operatorsRes) && operatorsRes.length > 0) {
      operators = operatorsRes;
    } else {
      operators = [...SEED_OPERATORS];
    }
    if (Array.isArray(materialsRes) && materialsRes.length > 0) {
      materials = materialsRes;
    } else {
      materials = [...SEED_MATERIALS];
    }

    if (Array.isArray(jobsRes)) {
      jobs = jobsRes.map(j => {
        const mapped = {
          kpNumber: j.kpNumber || j.kpNo || j.ID || j.jobId || "",
          partName: j.partName || j.PartName || j["Part Name"] || j.Part || j.part || "Unknown Part",
          customer: j.customer || j.Customer || j.customerName || j.CustomerName || j["Customer Name"] || "Unknown Customer",
          quantity: Number(j.quantity || j.qty || j.Qty || 1),
          processType: j.processType || j.process || j["Process Type"] || "Plasma",
          priority: j.priority || "Normal",
          inspectionDate: j.inspectionDate || new Date().toISOString().split('T')[0],
          receivedDate: j.receivedDate || "",
          currentDepartment: j.currentDepartment || j.department || j.CurrentDepartment || "Inspection",
          status: j.status || j.Status || "Pending",
          operatorName: j.operatorName || j.operator || "",
          shift: j.shift || "",
          masking: j.masking || { status: "Pending", materials: [], holdHistory: [] },
          spraying: j.spraying || { status: "Pending" },
          grinding: j.grinding || { status: "Pending" },
          polishing: j.polishing || { status: "Pending" },
          finalInspection: j.finalInspection || { status: "Pending" },
          dispatch: j.dispatch || { status: "Pending" }
        };
        
        mapped.masking = mapped.masking || { status: "Pending", materials: [], holdHistory: [] };
        if (mapped.currentDepartment === "Masking") {
          if (!mapped.masking.materials || mapped.masking.materials.length === 0) {
            mapped.masking.materials = [
              { name: "Masking Tape", type: "Tape", batch: "MT-2026-06", unit: "KG", plannedQty: mapped.quantity, actualQty: 0 },
              { name: "High Temperature Putty", type: "Sealant", batch: "HTP-9921", unit: "Gram", plannedQty: 350, actualQty: 0 }
            ];
          } else {
            mapped.masking.materials.forEach(mat => {
              const matchedMat = materials.find(m => m.name.toLowerCase() === mat.name.toLowerCase());
              if (matchedMat) {
                if (!mat.type) mat.type = matchedMat.type;
                if (!mat.unit) mat.unit = matchedMat.unit;
                if (!mat.plannedQty || mat.plannedQty === 0) mat.plannedQty = matchedMat.plannedQty;
              }
            });
          }
        }
        mapped.spraying = mapped.spraying || { status: "Pending" };
        mapped.grinding = mapped.grinding || { status: "Pending", holdHistory: [] };
        mapped.grinding.status = mapped.grinding.status || "Pending";
        mapped.grinding.processType = mapped.grinding.processType || "";
        mapped.grinding.machineName = mapped.grinding.machineName || "";
        mapped.grinding.storeLocation = mapped.grinding.storeLocation || "";
        mapped.grinding.quantity = Number(mapped.grinding.quantity || mapped.quantity);
        mapped.grinding.startTime = mapped.grinding.startTime || null;
        mapped.grinding.endTime = mapped.grinding.endTime || null;
        mapped.grinding.durationMs = Number(mapped.grinding.durationMs || 0);
        mapped.grinding.activeTimeMs = Number(mapped.grinding.activeTimeMs || 0);
        mapped.grinding.lastStartedAt = mapped.grinding.lastStartedAt || null;
        mapped.grinding.lastPausedAt = mapped.grinding.lastPausedAt || null;
        mapped.grinding.holdHistory = mapped.grinding.holdHistory || [];
        mapped.grinding.operatorName = mapped.grinding.operatorName || "";
        mapped.grinding.remarks = mapped.grinding.remarks || "";
        mapped.grinding.qualityRemarks = mapped.grinding.qualityRemarks || "";
        mapped.grinding.notes = mapped.grinding.notes || "";
        
        mapped.polishing = mapped.polishing || { status: "Pending" };
        mapped.finalInspection = mapped.finalInspection || { status: "Pending" };
        mapped.dispatch = mapped.dispatch || { status: "Pending" };
        
        return mapped;
      });
    }
    if (Array.isArray(auditLogsRes)) {
      auditLogs = auditLogsRes
        .map(l => ({
          timestamp: l.timestamp || l.Time || l.Date || new Date().toISOString(),
          user: l.user || l.operator || l.Username || l.User || "System",
          role: l.role || "Operator",
          department: l.department || l.stage || l.Department || "Masking",
          kpNumber: l.kpNumber || l.kpNo || l.kpnumber || l.jobId || "N/A",
          action: l.action || l.Action || l.details || l.Details || "Event"
        }))
        .filter(l => l.action !== "Event" || l.user !== "System");
    } else {
      auditLogs = [];
    }
    console.log("State loaded successfully from Sheets backend.");
  } catch (err) {
    console.warn("Could not load state from backend (offline?):", err);
    if (!jobs || jobs.length === 0) {
      jobs = SEED_JOBS.map(j => {
        const copy = JSON.parse(JSON.stringify(j));
        return copy;
      });
      operators = [...SEED_OPERATORS];
      materials = [...SEED_MATERIALS];
      auditLogs = [...SEED_AUDIT_LOGS];
    }
  }
}

function saveState() {
  // Production data is persisted live to Google Sheets via POST endpoints. No local storage write.
}


function resetData() {
  if (confirm("Are you sure you want to reset all shop floor data to defaults? This clears all active timers and custom entries.")) {
    const isMock = localStorage.getItem("psp_auth_mock");
    localStorage.clear();
    if (isMock !== null) {
      localStorage.setItem("psp_auth_mock", isMock);
    }
    location.reload();
  }
}

// 2. LIVE CLOCK (updates header timestamp)
function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

function startAutoRefresh() {
  setInterval(async () => {
    if (pendingSyncCount > 0) {
      console.log("Skipping auto-refresh because backend sync is in progress.");
      return;
    }
    try {
      await loadState();
      renderAll();
      console.log("Auto-refreshed state from Google Sheets database.");
    } catch (e) {
      console.warn("Auto-refresh failed:", e);
    }
  }, 15000); // Poll every 15 seconds
}


function updateClock() {
  const now = new Date();
  const formatDigit = (num) => num.toString().padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${formatDigit(now.getMonth() + 1)}-${formatDigit(now.getDate())}`;
  const timeStr = `${formatDigit(now.getHours())}:${formatDigit(now.getMinutes())}:${formatDigit(now.getSeconds())}`;
  clockElement.textContent = `${dateStr} ${timeStr}`;
}

// 3. NAVIGATION SWITCHER
function setupNav() {
  navButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-tab");
      if (!targetTab) return;
      const hash = targetTab.replace('tab-', '');
      window.location.hash = `#/${hash}`;
    });
  });
}

function setupMaskingSubtabs() {
  const subtabButtons = document.querySelectorAll(".masking-tab-btn");
  const subtabPanels = document.querySelectorAll(".masking-subtab-panel");

  subtabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetSubtab = btn.getAttribute("data-subtab");
      if (!targetSubtab) return;

      activeMaskingSubtab = targetSubtab;
      
      subtabButtons.forEach(b => b.classList.remove("active"));
      subtabPanels.forEach(p => p.classList.remove("active"));

      btn.classList.add("active");
      const targetPanel = document.getElementById(targetSubtab);
      if (targetPanel) targetPanel.classList.add("active");

      // Re-render Masking View
      renderMaskingDashboard();
    });
  });
}

function setupHamburger() {
  const hamburgerBtn = document.getElementById("btn-hamburger");
  const appContainer = document.getElementById("app-container");
  const backdrop = document.getElementById("sidebar-backdrop");

  if (hamburgerBtn) {
    hamburgerBtn.addEventListener("click", () => {
      if (window.innerWidth <= 1280) {
        appContainer.classList.toggle("sidebar-open");
      } else {
        appContainer.classList.toggle("sidebar-collapsed");
      }
    });
  }

  if (backdrop) {
    backdrop.addEventListener("click", () => {
      appContainer.classList.remove("sidebar-open");
    });
  }
}

function switchToSubtab(subtabId) {
  activeMaskingSubtab = subtabId;
  const subtabButtons = document.querySelectorAll(".masking-tab-btn");
  const subtabPanels = document.querySelectorAll(".masking-subtab-panel");

  subtabButtons.forEach(btn => {
    if (btn.getAttribute("data-subtab") === subtabId) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  subtabPanels.forEach(panel => {
    if (panel.id === subtabId) {
      panel.classList.add("active");
    } else {
      panel.classList.remove("active");
    }
  });
}

function populateHeaderUser() {
  const display = document.getElementById("header-user-display");
  if (display && currentUser) {
    display.textContent = `${currentUser.email} (${currentUser.role.replace('_', ' ').toUpperCase()})`;
  }
}

// Get currently logged user in header
function getLoggedUser() {
  return {
    name: currentUser ? currentUser.email : "System Operator",
    shift: shiftSelect.value || "A Shift",
    role: currentUser ? currentUser.role : "System",
    department: currentUser ? currentUser.department : "System"
  };
}

function applySidebarPermissions() {
  const navBtns = document.querySelectorAll(".nav-btn");
  navBtns.forEach(btn => {
    const tabId = btn.getAttribute("data-tab");
    if (tabId && isTabAuthorized(tabId)) {
      btn.style.display = "flex";
    } else {
      btn.style.display = "none";
    }
  });
  
  const sepStages = document.getElementById("nav-sep-stages");
  const sepAdmin = document.getElementById("nav-sep-admin");
  if (currentUser && currentUser.role === 'operator') {
    if (sepStages) sepStages.style.display = "none";
    if (sepAdmin) sepAdmin.style.display = "none";
  } else {
    if (sepStages) sepStages.style.display = "block";
    if (sepAdmin) sepAdmin.style.display = "block";
  }
  
  const btnReset = document.getElementById("btn-reset-data");
  if (btnReset) {
    if (currentUser && currentUser.role === 'super_admin') {
      btnReset.style.display = "block";
    } else {
      btnReset.style.display = "none";
    }
  }

  // Load or unload the Spraying iframe dynamically based on tab permissions to prevent background execution of checks
  const sprayingIframe = document.getElementById("spraying-iframe");
  if (sprayingIframe) {
    if (isTabAuthorized("tab-spraying")) {
      if (!sprayingIframe.src || sprayingIframe.src.indexOf("spraying.html") === -1) {
        sprayingIframe.src = "spraying.html";
      }
    } else {
      sprayingIframe.src = "about:blank";
    }
  }
}

function handleRouting(isInitialLoad = false) {
  const activePane = document.querySelector(".tab-pane.active");
  const defaultTab = getDefaultTab();
  const hash = window.location.hash || `#/${defaultTab.replace('tab-', '')}`;
  const cleanHash = hash.replace('#/', '');
  const targetTabId = `tab-${cleanHash}`;

  if (activePane && activePane.id === "tab-spraying" && targetTabId !== "tab-spraying" && window.sprayingJobActive) {
    alert("Cannot switch screens while a Spraying job is in progress!");
    // Revert the hash change
    window.removeEventListener("hashchange", handleRouting);
    window.location.hash = "#/spraying";
    setTimeout(() => {
      window.addEventListener("hashchange", handleRouting);
    }, 50);
    return;
  }
  
  const pane = document.getElementById(targetTabId);
  if (!pane) {
    window.location.hash = `#/${defaultTab.replace('tab-', '')}`;
    return;
  }
  
  if (!isTabAuthorized(targetTabId)) {
    if (!isInitialLoad) {
      showAccessDeniedModal(cleanHash.toUpperCase());
    }
    window.location.hash = `#/${defaultTab.replace('tab-', '')}`;
    return;
  }
  
  switchToTab(targetTabId);
}

function switchToTab(tabId) {
  const navButtons = document.querySelectorAll(".nav-btn");
  const tabPanes = document.querySelectorAll(".tab-pane");
  
  navButtons.forEach(btn => {
    if (btn.getAttribute("data-tab") === tabId) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
  
  tabPanes.forEach(pane => {
    if (pane.id === tabId) {
      pane.classList.add("active");
    } else {
      pane.classList.remove("active");
    }
  });
  
  const appContainer = document.getElementById("app-container");
  if (appContainer) {
    appContainer.classList.remove("sidebar-open");
  }
  
  renderAll();
}

function showAccessDeniedModal(stageName) {
  const modal = document.getElementById("access-denied-modal");
  const reasonEl = document.getElementById("access-denied-reason");
  const detailsEl = document.getElementById("access-denied-user-details");
  if (modal && reasonEl) {
    reasonEl.textContent = `Access Denied to: ${stageName}`;
    if (detailsEl) {
      detailsEl.innerHTML = `
        <strong style="color: var(--status-hold);">Logged In User Diagnostics:</strong><br>
        <strong>Email:</strong> ${currentUser ? currentUser.email : "No active session user"}<br>
        <strong>Role:</strong> ${currentUser ? currentUser.role : "N/A"}<br>
        <strong>Department:</strong> ${currentUser ? currentUser.department : "N/A"}
      `;
    }
    modal.classList.add("active");
  }
  createAuditLog(currentUser ? currentUser.email : "System", null, `Security Alert: Unauthorized access attempt to ${stageName}`);
}

function applyControlRestrictions() {
  if (!currentUser) return;
  const isReadOnly = (currentUser.role === 'hr_admin' || currentUser.role === 'quality_admin');
  
  const timerActionsList = document.querySelectorAll(".timer-actions-bar");
  timerActionsList.forEach(bar => {
    bar.style.display = isReadOnly ? "none" : "flex";
  });
  
  const btnAddMat = document.getElementById("btn-add-mat-to-job");
  if (btnAddMat) {
    if (isReadOnly) {
      btnAddMat.style.display = "none";
    } else {
      btnAddMat.style.display = "inline-flex";
    }
  }
  
  const holdTriggerForm = document.getElementById("hold-trigger-form");
  if (holdTriggerForm) {
    if (isReadOnly) {
      holdTriggerForm.style.display = "none";
    } else {
      holdTriggerForm.style.display = "block";
    }
  }
  
  const inspectionForm = document.getElementById("inspection-job-form");
  if (inspectionForm && currentUser.role === 'hr_admin') {
    const formPanel = inspectionForm.closest(".panel");
    if (formPanel) formPanel.style.display = "none";
  } else if (inspectionForm) {
    const formPanel = inspectionForm.closest(".panel");
    if (formPanel) formPanel.style.display = "block";
  }

  // Grinding control restrictions
  const grindingTimerActions = document.getElementById("grinding-active-job-timer-interface");
  if (grindingTimerActions) {
    const opRemarks = document.getElementById("grinding-operator-remarks");
    const qualRemarks = document.getElementById("grinding-quality-remarks");
    const grindNotes = document.getElementById("grinding-notes");
    if (opRemarks) opRemarks.disabled = isReadOnly;
    if (qualRemarks) qualRemarks.disabled = isReadOnly;
    if (grindNotes) grindNotes.disabled = isReadOnly;
  }

  // Show or hide subtabs in the Masking stage dashboard based on user roles
  const supervisorBtn = document.querySelector('[data-subtab="masking-subtab-supervisor"]');
  if (supervisorBtn) {
    if (currentUser.role === 'super_admin' || currentUser.role === 'production_admin') {
      supervisorBtn.style.display = "flex";
    } else {
      supervisorBtn.style.display = "none";
      if (activeMaskingSubtab === "masking-subtab-supervisor") {
        switchToSubtab("masking-subtab-queue");
      }
    }
  }

  const materialsBtn = document.querySelector('[data-subtab="masking-subtab-materials"]');
  if (materialsBtn) {
    if (currentUser.role === 'super_admin' || currentUser.role === 'production_admin' || currentUser.role === 'hr_admin') {
      materialsBtn.style.display = "flex";
    } else {
      materialsBtn.style.display = "none";
      if (activeMaskingSubtab === "masking-subtab-materials") {
        switchToSubtab("masking-subtab-queue");
      }
    }
  }
}

// 4. AUDIT LOGGER
async function createAuditLog(user, kpNumber, action) {
  let userRole = "System";
  let userDept = "System";
  
  if (currentUser && currentUser.email === user) {
    userRole = currentUser.role;
    userDept = currentUser.department;
  }
  
  const department = kpNumber ? (jobs.find(j => j.kpNumber === kpNumber)?.currentDepartment || "Masking") : userDept;
  
  const log = {
    timestamp: new Date().toISOString(),
    user: user,
    role: userRole,
    department: department,
    kpNumber: kpNumber || "N/A",
    action: action
  };
  
  auditLogs.unshift(log);
  renderAuditLogs();

  if (!isMockMode()) {
    await createFirestoreAuditLog(user, department, kpNumber, "Event", action);
  } else {
    const payload = {
      type: "CREATE_AUDIT_LOG",
      user: user,
      department: department,
      kpNo: kpNumber || "N/A",
      action: action,
      details: `${userRole.toUpperCase()} action on component: ${action}`
    };
    
    try {
      fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.error("Failed to post audit log:", err);
    }
  }
}


// 5. TIME CONVERSION UTILITIES
function formatDuration(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms < 0) return "00:00:00";
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    seconds.toString().padStart(2, '0')
  ].join(':');
}

// 6. GLOBAL RENDERING MANAGER
function renderAll() {
  applyControlRestrictions();
  
  // Update sidebar count indicators
  updateSidebarCounts();
  
  // Render tabs
  renderWorkflowOverview();
  renderInspectionDashboard();
  renderMaskingDashboard();
  renderSprayingDashboard();
  renderGrindingDashboard();
  renderPolishingDashboard();
  renderFinalInspectionDashboard();
  renderDispatchDashboard();
  renderUserManagement();
  renderAuditLogs();
  renderDmdDashboard();
}

function updateSidebarCounts() {
  const countInspect = jobs.filter(j => j.currentDepartment === "Inspection").length;
  const countMasking = jobs.filter(j => j.currentDepartment === "Masking" && j.masking.status !== "Completed").length;
  const countSpraying = jobs.filter(j => j.currentDepartment === "Spraying" && j.spraying.status === "Pending").length;
  const countGrinding = jobs.filter(j => j.currentDepartment === "Grinding").length;
  const countPolishing = jobs.filter(j => j.currentDepartment === "Polishing").length;
  const countFinal = jobs.filter(j => j.currentDepartment === "Final Inspection").length;
  const countDispatch = jobs.filter(j => j.currentDepartment === "Dispatch").length;

  if (badgeInspection) badgeInspection.textContent = countInspect;
  if (badgeMasking) badgeMasking.textContent = countMasking;
  if (badgeSpraying) badgeSpraying.textContent = countSpraying;
  
  const badgeGrinding = document.getElementById("badge-count-grinding");
  const badgePolishing = document.getElementById("badge-count-polishing");
  const badgeFinal = document.getElementById("badge-count-final-inspection");
  const badgeDispatch = document.getElementById("badge-count-dispatch");
  
  if (badgeGrinding) badgeGrinding.textContent = countGrinding;
  if (badgePolishing) badgePolishing.textContent = countPolishing;
  if (badgeFinal) badgeFinal.textContent = countFinal;
  if (badgeDispatch) badgeDispatch.textContent = countDispatch;
}

// 7. TAB VIEW: MES WORKFLOW OVERVIEW
function renderWorkflowOverview() {
  const countInspect = jobs.filter(j => j.currentDepartment === "Inspection").length;
  const countMasking = jobs.filter(j => j.currentDepartment === "Masking" && j.masking.status !== "Completed").length;
  const countSpraying = jobs.filter(j => j.currentDepartment === "Spraying").length;
  const countGrinding = jobs.filter(j => j.currentDepartment === "Grinding").length;
  const countPolishing = jobs.filter(j => j.currentDepartment === "Polishing").length;
  const countFinal = jobs.filter(j => j.currentDepartment === "Final Inspection").length;
  const countDispatch = jobs.filter(j => j.currentDepartment === "Dispatch").length;

  document.getElementById("wf-count-inspection").textContent = countInspect;
  document.getElementById("wf-count-masking").textContent = countMasking;
  document.getElementById("wf-count-spraying").textContent = countSpraying;
  
  const wfGrinding = document.getElementById("wf-count-grinding");
  if (wfGrinding) wfGrinding.textContent = countGrinding;
  const wfPolishing = document.getElementById("wf-count-polishing");
  if (wfPolishing) wfPolishing.textContent = countPolishing;
  const wfFinal = document.getElementById("wf-count-final-inspection");
  if (wfFinal) wfFinal.textContent = countFinal;
  const wfDispatch = document.getElementById("wf-count-dispatch");
  if (wfDispatch) wfDispatch.textContent = countDispatch;

  const steps = [
    { id: "wf-step-inspection", count: countInspect },
    { id: "wf-step-masking", count: countMasking },
    { id: "wf-step-spraying", count: countSpraying },
    { id: "wf-step-grinding", count: countGrinding },
    { id: "wf-step-polishing", count: countPolishing },
    { id: "wf-step-final", count: countFinal },
    { id: "wf-step-dispatch", count: countDispatch }
  ];

  steps.forEach(step => {
    const el = document.getElementById(step.id);
    if (el) {
      if (step.count > 0) {
        el.classList.remove("disabled-step");
        el.classList.add("active-step");
      } else {
        el.classList.remove("active-step");
        el.classList.add("disabled-step");
      }
    }
  });

  const tbody = document.getElementById("overview-jobs-list");
  tbody.innerHTML = "";

  jobs.forEach(job => {
    const tr = document.createElement("tr");
    
    let priorityClass = "";
    if (job.priority === "Critical") priorityClass = "text-red font-bold";
    else if (job.priority === "High") priorityClass = "text-orange";

    let statusBadge = "";
    if (job.status === "Pending") statusBadge = `<span class="badge badge-pending">Pending</span>`;
    else if (job.status === "In Progress") statusBadge = `<span class="badge badge-progress">In Progress</span>`;
    else if (job.status === "Completed") statusBadge = `<span class="badge badge-completed">Completed</span>`;
    else if (job.status === "Hold") statusBadge = `<span class="badge badge-hold">Hold</span>`;
    else statusBadge = `<span class="badge badge-normal">${job.status}</span>`;

    tr.innerHTML = `
      <td class="font-mono font-bold text-cyan">${job.kpNumber}</td>
      <td>${job.partName}</td>
      <td>${job.customer}</td>
      <td class="font-mono">${job.quantity}</td>
      <td><span class="badge badge-normal">${job.processType}</span></td>
      <td><strong>${job.currentDepartment} Department</strong></td>
      <td>${statusBadge}</td>
      <td class="${priorityClass}">${job.priority}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Global helper: transition a job to any stage ──
function transitionToStage(job, stageName, operatorName) {
  job.currentDepartment = stageName;
  job.status = "Pending";
  
  if (stageName === "Masking") {
    job.masking = job.masking || {};
    job.masking.status = "Pending";
    if (!job.masking.materials || job.masking.materials.length === 0) {
      job.masking.materials = [
        { name: "Masking Tape", type: "Tape", batch: "MT-2026-06", unit: "KG", plannedQty: job.quantity, actualQty: 0 },
        { name: "High Temperature Putty", type: "Sealant", batch: "HTP-9921", unit: "Gram", plannedQty: 350, actualQty: 0 }
      ];
    }
  } else if (stageName === "Spraying") {
    job.spraying = job.spraying || {};
    job.spraying.status = "Pending";
  } else if (stageName === "Grinding") {
    job.grinding = job.grinding || {};
    job.grinding.status = "Pending";
    job.grinding.processType = "";
    job.grinding.machineName = "";
    job.grinding.storeLocation = "";
    job.grinding.quantity = job.quantity;
    job.grinding.startTime = null;
    job.grinding.endTime = null;
    job.grinding.durationMs = 0;
    job.grinding.activeTimeMs = 0;
    job.grinding.lastStartedAt = null;
    job.grinding.lastPausedAt = null;
    job.grinding.holdHistory = [];
    job.grinding.operatorName = "";
    job.grinding.remarks = "";
    job.grinding.qualityRemarks = "";
    job.grinding.notes = "";
  } else if (stageName === "Polishing") {
    job.polishing = job.polishing || {};
    job.polishing.status = "Pending";
  } else if (stageName === "Final Inspection") {
    job.finalInspection = job.finalInspection || {};
    job.finalInspection.status = "Pending";
  } else if (stageName === "Dispatch") {
    job.dispatch = job.dispatch || {};
    job.dispatch.status = "Pending";
  }
}

// 8. TAB VIEW: INSPECTION DASHBOARD (Simulated Job Registration & Approval)
function renderInspectionDashboard() {
  const tbody = document.getElementById("inspection-queue-list");
  tbody.innerHTML = "";

  const inspectJobs = jobs.filter(j => j.currentDepartment === "Inspection");

  if (inspectJobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No components under active inspection.</td></tr>`;
  } else {
    inspectJobs.forEach(job => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="font-mono font-bold text-cyan">${job.kpNumber}</td>
        <td>${job.partName}</td>
        <td>${job.customer}</td>
        <td class="font-mono">${job.quantity}</td>
        <td><span class="badge badge-normal">${job.processType}</span></td>
        <td><span class="badge badge-pending">Inspection Pending</span></td>
        <td>
          <select id="inspect-next-stage-${job.kpNumber}" class="form-input select-sm" style="display:inline-block; width:auto; margin-right:5px; height:30px; padding:2px 5px; font-size:12px;">
            <option value="Inspection">Inspection</option>
            <option value="Masking" selected>Masking</option>
            <option value="Spraying">Spraying</option>
            <option value="Grinding">Grinding</option>
            <option value="Polishing">Polishing</option>
            <option value="Final Inspection">Final Inspection</option>
            <option value="Dispatch">Dispatch</option>
          </select>
          <button class="btn btn-success btn-xs" onclick="approveInspectionJob('${job.kpNumber}')">Approve Job</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Render Admin Workload tracking panel if admin is logged in
  const adminPanel = document.getElementById("admin-inspection-panel");
  if (adminPanel) {
    if (currentUser && currentUser.role !== 'operator') {
      adminPanel.style.display = "block";
      renderAdminInspectionTracking();
    } else {
      adminPanel.style.display = "none";
    }
  }
}

function renderAdminInspectionTracking() {
  const tbody = document.getElementById("admin-inspection-list");
  if (!tbody) return;
  tbody.innerHTML = "";
  
  const filterOp = document.getElementById("admin-filter-operator")?.value || "";
  const filterStat = document.getElementById("admin-filter-status")?.value || "";
  
  const filtered = inspectionMasterRecords.filter(r => {
    // Filter by Operator (case-insensitive and trimmed)
    if (filterOp) {
      const fOp = String(filterOp).trim().toUpperCase();
      const aFirst = String(r.assignedFirst || "").trim().toUpperCase();
      const aSecond = String(r.assignedSecond || "").trim().toUpperCase();
      if (aFirst !== fOp && aSecond !== fOp) return false;
    }
    
    // Filter by Status
    if (filterStat) {
      const isDel = r.status && r.status.toLowerCase() === 'delivered';
      if (filterStat === 'Delivered' && !isDel) return false;
      if (filterStat === 'Active' && isDel) return false;
    }
    return true;
  });
  
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No assignments found.</td></tr>`;
    return;
  }
  
  filtered.forEach(r => {
    const tr = document.createElement("tr");
    
    let statusClass = "badge-pending";
    if (r.status && r.status.toLowerCase() === 'delivered') {
      statusClass = "badge-completed";
    } else if (r.status && r.status.toLowerCase() === 'rework') {
      statusClass = "badge-hold";
    } else if (r.status && r.status.toLowerCase().includes("delivered")) {
      statusClass = "badge-hold"; // e.g. Half Delivered
    }
    
    // Process Google Sheets date serials or Date strings
    let lastUpdatedStr = "N/A";
    if (r.timestamp) {
      const match = r.timestamp.match(/Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)/);
      if (match) {
        const y = match[1];
        const m = String(Number(match[2]) + 1).padStart(2, '0');
        const d = String(match[3]).padStart(2, '0');
        const h = match[4] ? String(match[4]).padStart(2, '0') : '00';
        const min = match[5] ? String(match[5]).padStart(2, '0') : '00';
        const s = match[6] ? String(match[6]).padStart(2, '0') : '00';
        lastUpdatedStr = `${y}-${m}-${d} ${h}:${min}:${s}`;
      } else {
        const d = new Date(r.timestamp);
        if (!isNaN(d.getTime())) {
          lastUpdatedStr = d.toISOString().replace('T', ' ').substring(0, 19);
        } else {
          lastUpdatedStr = r.timestamp;
        }
      }
    }
    
    tr.innerHTML = `
      <td class="font-mono font-bold text-cyan">${r.kpNo}</td>
      <td>${r.customer}</td>
      <td>${r.partName}</td>
      <td class="font-mono">${r.quantity}</td>
      <td><span class="badge badge-normal">${r.assignedFirst || 'None'}</span></td>
      <td><span class="badge ${statusClass}">${r.status || 'N/A'}</span></td>
      <td class="font-mono" style="font-size:11px;">${lastUpdatedStr}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function approveInspectionJob(kpNumber) {
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (job) {
    const selectEl = document.getElementById(`inspect-next-stage-${kpNumber}`);
    const nextDept = selectEl ? selectEl.value : "Masking";
    
    const payload = {
      type: "END_CYCLE",
      kpNo: kpNumber,
      stage: "Inspection",
      operatorName: getLoggedUser().name,
      endTime: new Date().toISOString(),
      activeTimeMs: 0,
      nextStage: nextDept
    };
    
    // Optimistic UI mutation
    transitionToStage(job, nextDept, getLoggedUser().name);
    renderAll();
    
    // Background sync
    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync inspection approval to backend:", err);
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      });
  }
}


// 9. TAB VIEW: MASKING DASHBOARD
function renderMaskingDashboard() {
  // Update supervisor cards and production summaries
  renderSupervisorPanel();
  renderDailySummary();
  
  // Render queues, cards, histories
  renderLiveJobQueue();
  renderActiveJobTimer();
  renderActiveJobCards();
  renderMaterialConsumption();
  renderHoldManagementPanel();
  renderOperatorRegistry();
  renderCycleChronology();
  renderJobHistory();
}

// Module 7: Supervisor Control Panel
function renderSupervisorPanel() {
  const waiting = jobs.filter(j => j.currentDepartment === "Masking" && j.masking?.status === "Pending").length;
  const progress = jobs.filter(j => j.currentDepartment === "Masking" && j.masking?.status === "In Progress").length;
  const completed = jobs.filter(j => j.masking?.status === "Completed").length;
  
  // Active operators count is number of operators assigned to current running jobs
  const runningJobs = jobs.filter(j => j.currentDepartment === "Masking" && j.masking?.status === "In Progress");
  const activeOpsSet = new Set(runningJobs.map(j => j.masking?.operatorName).filter(Boolean));
  const activeOpsCount = activeOpsSet.size;

  // Calculate Average Cycle Time of Completed Masking jobs
  const completedMaskingJobs = jobs.filter(j => j.masking?.status === "Completed");
  let avgCycleStr = "00:00:00";
  if (completedMaskingJobs.length > 0) {
    const totalDuration = completedMaskingJobs.reduce((sum, j) => sum + (j.masking?.durationMs || 0), 0);
    const avgMs = totalDuration / completedMaskingJobs.length;
    avgCycleStr = formatDuration(avgMs);
  }

  // Calculate Department Utilization: (Active Operators / Total Shift Capacity (e.g. 5)) * 100
  const totalOpsCapacity = operators.length || 5;
  const utilization = Math.round((activeOpsCount / totalOpsCapacity) * 100);

  document.getElementById("sup-kps-waiting").textContent = waiting;
  document.getElementById("sup-kps-progress").textContent = progress;
  document.getElementById("sup-kps-completed").textContent = completed;
  document.getElementById("sup-ops-active").textContent = activeOpsCount;
  document.getElementById("sup-avg-cycle").textContent = avgCycleStr;
  document.getElementById("sup-utilization").textContent = `${utilization}%`;
}


// Module 6: Daily Production Summary
function renderDailySummary() {
  // Filter jobs completed today
  const todayStr = new Date().toISOString().split('T')[0];
  const jobsCompletedToday = jobs.filter(j => {
    if (j.masking?.status !== "Completed" || !j.masking?.endTime) return false;
    const endDay = j.masking.endTime.split('T')[0];
    return endDay === todayStr;
  });

  const kpsProcessedToday = jobsCompletedToday.length;
  const partsProcessedToday = jobsCompletedToday.reduce((sum, j) => sum + j.quantity, 0);

  // Sum materials consumed by completed jobs today
  let totalMaterialKg = 0;
  jobsCompletedToday.forEach(j => {
    j.masking?.materials?.forEach(mat => {
      let qtyKg = parseFloat(mat.actualQty) || 0;
      if (mat.unit.toLowerCase() === "gram" || mat.unit.toLowerCase() === "g") {
        qtyKg = qtyKg / 1000; // Normalise to KG
      }
      totalMaterialKg += qtyKg;
    });
  });

  const pendingKpsLeft = jobs.filter(j => j.currentDepartment === "Masking" && j.masking?.status !== "Completed").length;


  document.getElementById("day-kps-processed").textContent = kpsProcessedToday;
  document.getElementById("day-parts-processed").textContent = partsProcessedToday;
  document.getElementById("day-material-consumed").textContent = `${totalMaterialKg.toFixed(2)} KG`;
  document.getElementById("day-jobs-pending").textContent = pendingKpsLeft;
  document.getElementById("day-jobs-completed").textContent = kpsProcessedToday;
  document.getElementById("day-shift-display").textContent = getLoggedUser().shift;
}

// Module 1: Live Job Queue
function renderLiveJobQueue() {
  const cardsContainer = document.getElementById("masking-queue-cards");
  if (!cardsContainer) return;
  cardsContainer.innerHTML = "";

  // Get active queue filters
  const filterKp = document.getElementById("filter-kp").value.toLowerCase();
  const filterCust = document.getElementById("filter-customer").value.toLowerCase();
  const filterProc = document.getElementById("filter-process").value;
  const filterStat = document.getElementById("filter-status").value;

  const queueJobs = jobs.filter(j => {
    // Only jobs currently in Masking, not yet Completed
    if (j.currentDepartment !== "Masking" || j.masking.status === "Completed") return false;
    
    // Apply filters
    if (filterKp && !j.kpNumber.toLowerCase().includes(filterKp)) return false;
    if (filterCust && !j.customer.toLowerCase().includes(filterCust)) return false;
    if (filterProc && j.processType !== filterProc) return false;
    if (filterStat && j.masking.status !== filterStat) return false;
    
    return true;
  });

  if (queueJobs.length === 0) {
    cardsContainer.innerHTML = `<div class="no-selection-message" style="grid-column: 1 / -1; width: 100%;">No jobs match the queue filters.</div>`;
    return;
  }

  queueJobs.forEach(job => {
    const card = document.createElement("div");
    card.className = "job-queue-card";
    
    let statusClass = "badge-pending";
    if (job.masking.status === "In Progress") statusClass = "badge-progress";
    else if (job.masking.status === "Hold") statusClass = "badge-hold";

    let priorityClass = "";
    if (job.priority === "Critical") priorityClass = "text-red font-bold";
    else if (job.priority === "High") priorityClass = "text-orange";

    let actionButton = "";
    if (job.masking.status === "Pending") {
      actionButton = `<button class="btn btn-success btn-tablet-primary" onclick="openAssignModal('${job.kpNumber}')">START MASKING</button>`;
    } else {
      actionButton = `<button class="btn btn-primary btn-tablet-primary" onclick="selectActiveJobAndSwitch('${job.kpNumber}')">VIEW STATION</button>`;
    }

    card.innerHTML = `
      <div class="job-card-header">
        <span class="job-card-kp">${job.kpNumber}</span>
        <span class="badge ${statusClass}">${job.masking.status}</span>
      </div>
      <div class="job-card-body">
        <div class="job-card-row">
          <span class="job-card-label">Part Name:</span>
          <span class="job-card-value">${job.partName}</span>
        </div>
        <div class="job-card-row">
          <span class="job-card-label">Customer:</span>
          <span class="job-card-value">${job.customer}</span>
        </div>
        <div class="job-card-row">
          <span class="job-card-label">Quantity:</span>
          <span class="job-card-value font-mono">${job.quantity} pcs</span>
        </div>
        <div class="job-card-row">
          <span class="job-card-label">Process Type:</span>
          <span class="job-card-value"><span class="badge badge-normal">${job.processType}</span></span>
        </div>
        <div class="job-card-row">
          <span class="job-card-label">Priority:</span>
          <span class="job-card-value ${priorityClass}">${job.priority}</span>
        </div>
      </div>
      <div class="job-card-actions">
        ${actionButton}
      </div>
    `;
    cardsContainer.appendChild(card);
  });
}

function selectActiveJobAndSwitch(kpNumber) {
  selectActiveJob(kpNumber);
  switchToSubtab("masking-subtab-active");
}

// Module 2: Active Operation Panel (Digital Timer)
function renderActiveJobTimer() {
  const container = document.getElementById("active-job-timer-interface");
  const noJobMsg = document.getElementById("no-active-job-message");

  if (!selectedJobKp) {
    container.style.display = "none";
    noJobMsg.style.display = "flex";
    return;
  }

  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job || job.currentDepartment !== "Masking" || job.masking.status === "Completed") {
    selectedJobKp = null;
    container.style.display = "none";
    noJobMsg.style.display = "flex";
    return;
  }

  // Populate active UI fields
  noJobMsg.style.display = "none";
  container.style.display = "flex";

  document.getElementById("active-kp-no").textContent = job.kpNumber;
  document.getElementById("active-part-name").textContent = job.partName;
  document.getElementById("active-customer").textContent = job.customer;
  document.getElementById("active-qty").textContent = job.quantity;
  
  const processBadge = document.getElementById("active-process");
  processBadge.textContent = job.processType;
  
  document.getElementById("active-operator-display").textContent = job.masking.operatorName || "Unassigned";
  document.getElementById("active-shift-display").textContent = job.masking.shift || "Unassigned";

  // Cycle Status Badge Color Update
  const statusBadge = document.getElementById("active-cycle-status-badge");
  statusBadge.className = "badge";
  if (job.masking.status === "In Progress") {
    statusBadge.classList.add("badge-progress");
    statusBadge.textContent = "RUNNING";
  } else if (job.masking.status === "Hold") {
    statusBadge.classList.add("badge-hold");
    statusBadge.textContent = "ON HOLD";
  } else {
    statusBadge.classList.add("badge-normal");
    statusBadge.textContent = "STANDBY";
  }

  // Manage Action buttons layout based on status
  const btnStart = document.getElementById("btn-start-cycle");
  const btnPause = document.getElementById("btn-pause-cycle");
  const btnResume = document.getElementById("btn-resume-cycle");
  const btnEnd = document.getElementById("btn-end-cycle");

  if (job.masking.status === "Pending") {
    btnStart.style.display = "block";
    btnPause.style.display = "none";
    btnResume.style.display = "none";
    btnEnd.style.display = "none";
  } else if (job.masking.status === "In Progress") {
    btnStart.style.display = "none";
    btnPause.style.display = "block";
    btnResume.style.display = "none";
    btnEnd.style.display = "block";
  } else if (job.masking.status === "Hold") {
    btnStart.style.display = "none";
    btnPause.style.display = "none";
    btnResume.style.display = "block";
    btnEnd.style.display = "block";
  }

  updateTimerReadout(job);
}

// Module 3: Active Job Cards
function renderActiveJobCards() {
  const container = document.getElementById("active-job-cards-container");
  container.innerHTML = "";

  const activeJobs = jobs.filter(j => j.currentDepartment === "Masking" && j.masking.status !== "Pending" && j.masking.status !== "Completed");

  if (activeJobs.length === 0) {
    container.innerHTML = `<div class="no-selection-message">No running masking cycles on the shop floor.</div>`;
    return;
  }

  activeJobs.forEach(job => {
    const card = document.createElement("div");
    card.className = "active-card";
    if (job.kpNumber === selectedJobKp) {
      card.classList.add("selected-card");
    }

    card.addEventListener("click", () => {
      selectActiveJob(job.kpNumber);
    });

    let statusBadgeClass = "badge-progress";
    if (job.masking.status === "Hold") statusBadgeClass = "badge-hold";

    // Dynamic timing calculation for card
    let runningMs = job.masking.activeTimeMs || 0;
    if (job.masking.status === "In Progress" && job.masking.lastStartedAt) {
      const start = new Date(job.masking.lastStartedAt).getTime();
      const now = new Date().getTime();
      runningMs += (now - start);
    }

    card.innerHTML = `
      <div class="card-left">
        <div class="card-kp-row">
          <span class="card-kp">${job.kpNumber}</span>
          <span class="badge ${statusBadgeClass} text-xs">${job.masking.status}</span>
        </div>
        <span class="card-part">${job.partName} (${job.quantity} pcs)</span>
        <span class="card-op-info">Operator: ${job.masking.operatorName}</span>
      </div>
      <div class="card-right">
        <span class="card-time font-mono">${formatDuration(runningMs)}</span>
        <span class="text-xs text-muted">Active Run</span>
      </div>
    `;
    container.appendChild(card);
  });
}

// Timer sub-ticks runner
function startStateTimer() {
  if (timerIntervalId) clearInterval(timerIntervalId);
  
  timerIntervalId = setInterval(() => {
    // 1. Loop through all jobs to verify running ones and recalculate their running cards duration
    let isAnyJobRunning = false;
    jobs.forEach(job => {
      if (job.currentDepartment === "Masking" && job.masking.status === "In Progress") {
        isAnyJobRunning = true;
      }
      if (job.currentDepartment === "Grinding" && job.grinding?.status === "In Progress") {
        isAnyJobRunning = true;
      }
    });

    // 2. If selected masking job is running, refresh the main digital screen
    if (selectedJobKp) {
      const activeJob = jobs.find(j => j.kpNumber === selectedJobKp);
      if (activeJob) {
        updateTimerReadout(activeJob);
        // Live update active operator stats if they are working
        updateOperatorLiveTimes();
      }
    }

    // 3. If selected grinding job is running, refresh the grinding digital screen
    if (selectedGrindingJobKp) {
      const activeGrindingJob = jobs.find(j => j.kpNumber === selectedGrindingJobKp);
      if (activeGrindingJob) {
        updateGrindingTimerReadout(activeGrindingJob);
      }
    }

    // 4. Keep running cards and panels updating
    renderActiveJobCards();
    if (typeof renderGrindingActiveCards === "function") {
      renderGrindingActiveCards();
    }
  }, 1000);
}

function updateTimerReadout(job) {
  const currentTimerDigits = document.getElementById("timer-cycle-current");
  const totalActiveDigits = document.getElementById("timer-total-active");

  if (!currentTimerDigits || !totalActiveDigits) return;

  let elapsedCurrent = 0;
  let totalActive = job.masking.activeTimeMs || 0;

  if (job.masking.status === "In Progress" && job.masking.lastStartedAt) {
    const start = new Date(job.masking.lastStartedAt).getTime();
    const now = new Date().getTime();
    elapsedCurrent = Math.max(0, now - start);
    totalActive += elapsedCurrent;
  }

  currentTimerDigits.textContent = formatDuration(elapsedCurrent);
  totalActiveDigits.textContent = formatDuration(totalActive);
}

function updateGrindingTimerReadout(job) {
  const currentTimerDigits = document.getElementById("grinding-timer-readout");
  const startedTimeDigits = document.getElementById("grinding-time-started");
  const pausedTimeDigits = document.getElementById("grinding-time-paused-total");

  if (!currentTimerDigits) return;

  let totalActive = job.grinding.activeTimeMs || 0;

  if (job.grinding.status === "In Progress" && job.grinding.lastStartedAt) {
    const start = new Date(job.grinding.lastStartedAt).getTime();
    const now = new Date().getTime();
    const elapsedCurrent = Math.max(0, now - start);
    totalActive += elapsedCurrent;
  }

  currentTimerDigits.textContent = formatDuration(totalActive);
  
  if (startedTimeDigits && job.grinding.startTime) {
    startedTimeDigits.textContent = new Date(job.grinding.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } else if (startedTimeDigits) {
    startedTimeDigits.textContent = "--:--:--";
  }

  if (pausedTimeDigits) {
    let pausedMs = 0;
    if (job.grinding.startTime) {
      const start = new Date(job.grinding.startTime).getTime();
      const end = job.grinding.endTime ? new Date(job.grinding.endTime).getTime() : new Date().getTime();
      pausedMs = Math.max(0, (end - start) - totalActive);
    }
    pausedTimeDigits.textContent = formatDuration(pausedMs);
  }
}

// Live increment operators active metrics on running jobs
function updateOperatorLiveTimes() {
  const activeJob = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!activeJob || activeJob.masking.status !== "In Progress") return;

  const opName = String(activeJob.masking.operatorName || "").trim().toUpperCase();
  const op = operators.find(o => o.name && String(o.name).trim().toUpperCase() === opName);
  if (op) {
    // Increment active time by 1s (1000ms)
    op.activeTimeMs = (op.activeTimeMs || 0) + 1000;
    
    // Periodically save state (e.g. every 5 seconds to reduce storage cycles)
    const secondCount = Math.floor(Date.now() / 1000);
    if (secondCount % 5 === 0) {
      saveState();
      renderOperatorRegistry();
    }
  }
}

// Module 4: Material Consumption Tracking
function renderMaterialConsumption() {
  const interfaceDiv = document.getElementById("material-tracking-interface");
  const noJobDiv = document.getElementById("no-material-job-selected");

  if (!selectedJobKp) {
    interfaceDiv.style.display = "none";
    noJobDiv.style.display = "flex";
    return;
  }

  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job || job.currentDepartment !== "Masking") {
    interfaceDiv.style.display = "none";
    noJobDiv.style.display = "flex";
    return;
  }

  noJobDiv.style.display = "none";
  interfaceDiv.style.display = "block";

  document.getElementById("mat-active-kp").textContent = job.kpNumber;

  // Render Material Selection Dropdown inside the consumer
  // Preserve the currently selected value across re-renders
  const matSelect = document.getElementById("mat-add-select");
  const previousSelectedMat = matSelect.value;
  matSelect.innerHTML = "";
  materials.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m.name;
    opt.textContent = `${m.name} (${m.type} - Batch: ${m.batch})`;
    matSelect.appendChild(opt);
  });
  // Restore previous selection if it still exists in the options
  if (previousSelectedMat) {
    const matchingOption = Array.from(matSelect.options).find(o => o.value === previousSelectedMat);
    if (matchingOption) matSelect.value = previousSelectedMat;
  }

  // Render Table Rows
  const tbody = document.getElementById("materials-tracking-rows");
  tbody.innerHTML = "";

  const jobMats = job.masking.materials || [];
  if (jobMats.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No materials assigned to this job. Add one below.</td></tr>`;
  } else {
    jobMats.forEach((mat, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="font-bold">${mat.name}</td>
        <td class="text-muted">${mat.type}</td>
        <td class="font-mono text-xs">${mat.batch}</td>
        <td class="font-mono">${mat.plannedQty}</td>
        <td>
          <div class="qty-adjust-container">
            <button type="button" class="btn-qty-adjust" onclick="adjustMaterialQty('${job.kpNumber}', ${idx}, -1)" ${job.masking.status === 'Completed' ? 'disabled' : ''}>-</button>
            <input type="number" step="0.01" min="0" 
              value="${mat.actualQty || 0}" 
              class="qty-adjust-input font-mono" 
              id="mat-actual-input-${idx}"
              onchange="updateJobMaterialActual('${job.kpNumber}', ${idx}, this.value)"
              ${job.masking.status === 'Completed' ? 'disabled' : ''}>
            <button type="button" class="btn-qty-adjust" onclick="adjustMaterialQty('${job.kpNumber}', ${idx}, 1)" ${job.masking.status === 'Completed' ? 'disabled' : ''}>+</button>
          </div>
        </td>
        <td><span class="badge badge-normal">${mat.unit}</span></td>
        <td>
          <button class="btn btn-danger btn-xs" 
            onclick="removeMaterialFromJob('${job.kpNumber}', ${idx})"
            ${job.masking.status === 'Completed' ? 'disabled' : ''} style="height: 60px; font-size: 16px;">Remove</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Calculate Materials Summary metrics
  calculateMaterialSummaries(job);
}

function adjustMaterialQty(kpNumber, index, dir) {
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (job && job.masking.materials[index]) {
    const mat = job.masking.materials[index];
    let step = 0.1;
    if (mat.unit.toLowerCase() === "gram" || mat.unit.toLowerCase() === "g" || mat.unit.toLowerCase() === "pc" || mat.unit.toLowerCase() === "pcs") {
      step = 10;
    }
    const currentVal = parseFloat(mat.actualQty) || 0;
    let newVal = currentVal + (dir * step);
    if (newVal < 0) newVal = 0;
    
    // Round to 2 decimals
    newVal = Math.round(newVal * 100) / 100;
    
    // Update local state immediately for instant UI feedback
    mat.actualQty = newVal;
    renderMaterialConsumption();
    
    // Then persist to backend in background
    updateJobMaterialActual(kpNumber, index, newVal);
  }
}

function calculateMaterialSummaries(job) {
  const jobMats = job.masking.materials || [];
  let totalKg = 0;
  let summaryParts = job.quantity || 1;

  jobMats.forEach(m => {
    let actualVal = parseFloat(m.actualQty) || 0;
    if (m.unit.toLowerCase() === "gram" || m.unit.toLowerCase() === "g") {
      actualVal = actualVal / 1000;
    }
    totalKg += actualVal;
  });

  const usagePerPart = totalKg / summaryParts;

  document.getElementById("calc-total-used").textContent = `${totalKg.toFixed(3)} KG`;
  document.getElementById("calc-usage-part").textContent = `${usagePerPart.toFixed(3)} KG/pc`;
}

async function updateJobMaterialActual(kpNumber, index, val) {
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (job && job.masking.materials[index]) {
    const floatVal = parseFloat(val);
    const mat = job.masking.materials[index];
    const actualQty = isNaN(floatVal) ? 0 : floatVal;

    // Update local state immediately so the UI stays responsive
    mat.actualQty = actualQty;
    calculateMaterialSummaries(job);
    renderMaterialConsumption();

    // Debounce backend sync requests to avoid lock timeout exceptions
    const timerKey = `${kpNumber}_${index}`;
    if (materialSyncTimers[timerKey]) {
      clearTimeout(materialSyncTimers[timerKey]);
    }

    materialSyncTimers[timerKey] = setTimeout(async () => {
      delete materialSyncTimers[timerKey];

      const payload = {
        type: "ADD_MATERIAL_CONSUMPTION",
        kpNo: kpNumber,
        stage: "Masking",
        materialName: mat.name,
        materialType: mat.type,
        batch: mat.batch,
        unit: mat.unit,
        plannedQty: mat.plannedQty,
        actualQty: actualQty,
        operatorName: getLoggedUser().name
      };

      try {
        await sendBackendPost(payload);
        console.log("Material qty synced to backend:", mat.name, actualQty);
      } catch (err) {
        console.error("Failed to sync material qty to backend:", err);
      }
    }, 1000); // 1-second debounce delay
  }
}

async function removeMaterialFromJob(kpNumber, index) {
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (job && job.masking.materials[index]) {
    const mat = job.masking.materials[index];
    const payload = {
      type: "DELETE_MATERIAL_CONSUMPTION",
      kpNo: kpNumber,
      stage: "Masking",
      materialName: mat.name,
      operatorName: getLoggedUser().name
    };

    // Optimistic UI mutation
    job.masking.materials.splice(index, 1);
    renderMaterialConsumption();
    renderAll();

    // Background sync
    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync material deletion:", err);
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      });
  }
}

async function addMaterialToJob() {
  if (!selectedJobKp) return;
  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job) return;

  const matName = document.getElementById("mat-add-select").value;
  const plannedQty = parseFloat(document.getElementById("mat-add-qty").value);

  if (isNaN(plannedQty) || plannedQty <= 0) {
    alert("Please enter a valid planned quantity.");
    return;
  }

  const baseMat = materials.find(m => m.name === matName);
  if (baseMat) {
    const payload = {
      type: "ADD_MATERIAL_CONSUMPTION",
      kpNo: selectedJobKp,
      stage: "Masking",
      materialName: baseMat.name,
      materialType: baseMat.type,
      batch: baseMat.batch,
      unit: baseMat.unit,
      plannedQty: plannedQty,
      actualQty: 0,
      operatorName: getLoggedUser().name
    };

    // Optimistic UI mutation
    const newMat = {
      name: baseMat.name,
      type: baseMat.type,
      batch: baseMat.batch,
      unit: baseMat.unit,
      plannedQty: plannedQty,
      actualQty: 0
    };
    job.masking.materials = job.masking.materials || [];
    job.masking.materials.push(newMat);

    document.getElementById("mat-add-qty").value = "";
    renderMaterialConsumption();
    renderAll();

    // Background sync
    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync material addition:", err);
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      });
  }
}


// Module 9: Hold Management
function renderHoldManagementPanel() {
  const interfaceDiv = document.getElementById("hold-controls-interface");
  const noJobDiv = document.getElementById("no-hold-job-selected");

  if (!interfaceDiv || !noJobDiv) return;

  if (!selectedJobKp) {
    interfaceDiv.style.display = "none";
    noJobDiv.style.display = "flex";
    return;
  }

  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job || job.currentDepartment !== "Masking") {
    interfaceDiv.style.display = "none";
    noJobDiv.style.display = "flex";
    return;
  }

  noJobDiv.style.display = "none";
  interfaceDiv.style.display = "block";

  const holdStatusLbl = document.getElementById("hold-status-lbl");
  holdStatusLbl.className = "badge";

  const triggerForm = document.getElementById("hold-trigger-form");
  const resumeSection = document.getElementById("hold-resume-section");
  const holdTimeLog = document.getElementById("hold-time-log");

  if (job.masking.status === "Hold") {
    holdStatusLbl.classList.add("badge-hold");
    holdStatusLbl.textContent = "PAUSED (HOLD)";
    triggerForm.style.display = "none";
    resumeSection.style.display = "block";

    // Show hold timestamps
    const lastHold = job.masking.holdHistory[job.masking.holdHistory.length - 1];
    if (lastHold) {
      holdTimeLog.innerHTML = `Job put on hold: ${new Date(lastHold.holdTime).toLocaleTimeString()}<br>Reason: ${lastHold.reason}`;
    }
  } else {
    holdStatusLbl.classList.add("badge-progress");
    holdStatusLbl.textContent = job.masking.status;
    triggerForm.style.display = "block";
    resumeSection.style.display = "none";
    holdTimeLog.textContent = "";

    // Set up reason button click listeners
    const reasonContainer = document.getElementById("hold-reason-buttons");
    if (reasonContainer) {
      reasonContainer.querySelectorAll(".touch-select-btn").forEach(btn => {
        const reasonVal = btn.getAttribute("data-reason");
        
        // highlight active state
        if (reasonVal === selectedHoldReason) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }

        btn.onclick = () => {
          reasonContainer.querySelectorAll(".touch-select-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          selectedHoldReason = reasonVal;
        };
      });
    }
  }
}

async function submitHoldJob() {
  if (!selectedJobKp) return;
  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job || job.masking.status !== "In Progress") {
    alert("Job must be actively running in progress to place it on hold.");
    return;
  }

  if (!selectedHoldReason) {
    alert("Please select a hold reason by tapping one of the reason buttons first.");
    return;
  }

  const notesEl = document.getElementById("hold-notes");
  const notes = notesEl ? notesEl.value : "";
  const now = new Date();

  // 1. Calculate and store elapsed running duration up to this pause point
  let elapsed = 0;
  if (job.masking.lastStartedAt) {
    elapsed = now.getTime() - new Date(job.masking.lastStartedAt).getTime();
  }
  const finalActiveTimeMs = (job.masking.activeTimeMs || 0) + elapsed;

  // 2. Build Hold Record
  const newHoldRecord = {
    holdTime: now.toISOString(),
    resumeTime: null,
    reason: selectedHoldReason,
    notes: notes
  };
  const updatedHoldHistory = [...(job.masking.holdHistory || []), newHoldRecord];

  const payload = {
    type: "PAUSE_CYCLE",
    kpNo: selectedJobKp,
    stage: "Masking",
    operatorName: getLoggedUser().name,
    activeTimeMs: finalActiveTimeMs,
    holdHistory: updatedHoldHistory,
    holdReason: selectedHoldReason
  };

  // Optimistic UI mutation
  job.masking.status = "Hold";
  job.masking.activeTimeMs = finalActiveTimeMs;
  job.masking.lastPausedAt = now.toISOString();
  job.masking.holdHistory = updatedHoldHistory;

  // Clear selection
  selectedHoldReason = null;
  const reasonContainer = document.getElementById("hold-reason-buttons");
  if (reasonContainer) {
    reasonContainer.querySelectorAll(".touch-select-btn").forEach(b => b.classList.remove("active"));
  }
  if (notesEl) notesEl.value = "";

  renderAll();

  // Background sync
  pendingSyncCount++;
  sendBackendPost(payload)
    .then(() => {
      pendingSyncCount--;
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    })
    .catch(err => {
      pendingSyncCount--;
      console.error("Failed to sync hold action:", err);
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    });
}

async function submitResumeJob() {
  if (!selectedJobKp) return;
  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job || job.masking.status !== "Hold") return;

  const now = new Date();
  const updatedHoldHistory = [...(job.masking.holdHistory || [])];
  if (updatedHoldHistory.length > 0) {
    updatedHoldHistory[updatedHoldHistory.length - 1].resumeTime = now.toISOString();
  }

  const payload = {
    type: "RESUME_CYCLE",
    kpNo: selectedJobKp,
    stage: "Masking",
    operatorName: getLoggedUser().name,
    holdHistory: updatedHoldHistory
  };

  // Optimistic UI mutation
  job.masking.status = "In Progress";
  job.masking.lastStartedAt = now.toISOString();
  job.masking.holdHistory = updatedHoldHistory;

  renderAll();

  // Background sync
  pendingSyncCount++;
  sendBackendPost(payload)
    .then(() => {
      pendingSyncCount--;
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    })
    .catch(err => {
      pendingSyncCount--;
      console.error("Failed to sync resume action:", err);
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    });
}


// Module 5: Cycle Tracking Chronology
function renderCycleChronology() {
  const displayDiv = document.getElementById("cycle-tracking-display");
  const noJobDiv = document.getElementById("no-cycle-job-selected");

  if (!selectedJobKp) {
    displayDiv.style.display = "none";
    noJobDiv.style.display = "flex";
    return;
  }

  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job || job.currentDepartment !== "Masking") {
    displayDiv.style.display = "none";
    noJobDiv.style.display = "flex";
    return;
  }

  noJobDiv.style.display = "none";
  displayDiv.style.display = "block";

  document.getElementById("cycle-track-kp").textContent = job.kpNumber;

  const startT = job.masking.startTime ? new Date(job.masking.startTime).toLocaleTimeString() : "--:--:--";
  const endT = job.masking.endTime ? new Date(job.masking.endTime).toLocaleTimeString() : "UNDER OPERATION";
  
  document.getElementById("cycle-track-start").textContent = startT;
  document.getElementById("cycle-track-end").textContent = endT;

  // Duration
  let durationMs = job.masking.durationMs || 0;
  if (job.masking.status === "In Progress" && job.masking.lastStartedAt) {
    durationMs = (job.masking.activeTimeMs || 0) + (Date.now() - new Date(job.masking.lastStartedAt).getTime());
  } else if (job.masking.status === "Hold") {
    durationMs = job.masking.activeTimeMs || 0;
  }

  document.getElementById("cycle-track-duration").textContent = formatDuration(durationMs);

  // Render hold events
  const holdList = document.getElementById("cycle-track-hold-events");
  holdList.innerHTML = "";

  const history = job.masking.holdHistory || [];
  if (history.length === 0) {
    holdList.innerHTML = `<div class="text-muted">No hold interruptions logged.</div>`;
  } else {
    history.forEach(item => {
      const holdTimeStr = new Date(item.holdTime).toLocaleTimeString();
      const resumeTimeStr = item.resumeTime ? new Date(item.resumeTime).toLocaleTimeString() : "PENDING";
      
      const div = document.createElement("div");
      div.className = "hold-log-item";
      div.innerHTML = `
        <span><strong>${item.reason}</strong> (${item.notes || 'No remarks'})</span>
        <span>Hold: ${holdTimeStr} | Resume: ${resumeTimeStr}</span>
      `;
      holdList.appendChild(div);
    });
  }
}

// Module 10: Operator Management Registry
function renderOperatorRegistry() {
  const tbody = document.getElementById("operators-table-body");
  tbody.innerHTML = "";

  operators.forEach(op => {
    // Sum active hours
    const hours = (op.activeTimeMs / (1000 * 60 * 60)).toFixed(2);
    
    tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${op.name}</strong></td>
      <td class="font-mono">${op.shift}</td>
      <td class="font-mono text-center">${op.jobsAssigned}</td>
      <td class="font-mono text-center text-green">${op.jobsCompleted}</td>
      <td class="font-mono text-cyan">${hours} Hours</td>
    `;
    tbody.appendChild(tr);
  });
}

// Module 8: Job History Record
function renderJobHistory() {
  const tbody = document.getElementById("job-history-list");
  tbody.innerHTML = "";

  const histKp = document.getElementById("hist-filter-kp").value.toLowerCase();
  const histCust = document.getElementById("hist-filter-customer").value.toLowerCase();
  const histOp = document.getElementById("hist-filter-operator").value.toLowerCase();
  const histProc = document.getElementById("hist-filter-process").value;

  // History contains completed jobs or jobs that have progressed past masking
  const completedJobs = jobs.filter(j => {
    if (j.masking.status !== "Completed") return false;

    if (histKp && !j.kpNumber.toLowerCase().includes(histKp)) return false;
    if (histCust && !j.customer.toLowerCase().includes(histCust)) return false;
    if (histOp && !j.masking.operatorName.toLowerCase().includes(histOp)) return false;
    if (histProc && j.processType !== histProc) return false;

    return true;
  });

  if (completedJobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="text-center text-muted">No completed jobs found in the logs.</td></tr>`;
    return;
  }

  completedJobs.forEach(job => {
    const tr = document.createElement("tr");

    // Format start/end times
    const startStr = job.masking.startTime ? new Date(job.masking.startTime).toLocaleTimeString() : "--:--:--";
    const endStr = job.masking.endTime ? new Date(job.masking.endTime).toLocaleTimeString() : "--:--:--";
    const durStr = formatDuration(job.masking.durationMs);

    // Format material quantities
    const matStrings = job.masking.materials.map(m => `${m.name}: ${m.actualQty} ${m.unit}`);
    const matCell = matStrings.length > 0 ? matStrings.join("<br>") : "None";

    tr.innerHTML = `
      <td class="font-mono font-bold text-cyan">${job.kpNumber}</td>
      <td>${job.partName}</td>
      <td>${job.customer}</td>
      <td class="font-mono">${job.quantity}</td>
      <td>${job.masking.operatorName}</td>
      <td class="font-mono">${job.masking.shift}</td>
      <td class="font-mono text-xs">${startStr}</td>
      <td class="font-mono text-xs">${endStr}</td>
      <td class="font-mono text-cyan">${durStr}</td>
      <td class="text-muted text-xs">${matCell}</td>
      <td><span class="badge badge-completed">Completed</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// 10. TAB VIEW: SPRAYING DASHBOARD (Integrated React console in iframe)
function renderSprayingDashboard() {
  const sprayingIframe = document.getElementById("spraying-iframe");
  if (sprayingIframe && sprayingIframe.contentWindow) {
    sprayingIframe.contentWindow.dispatchEvent(new CustomEvent("refresh-spraying-data"));
  }
}

// 11. TAB VIEW: AUDIT LOG VIEWER
function renderAuditLogs() {
  const tbody = document.getElementById("audit-logs-table-body");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (auditLogs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No logs recorded in audit logger.</td></tr>`;
    return;
  }

  auditLogs.forEach(log => {
    const tr = document.createElement("tr");
    const formattedTime = new Date(log.timestamp).toLocaleTimeString();
    
    let actionColorClass = "";
    if (log.action.includes("Completed")) actionColorClass = "text-green";
    else if (log.action.includes("Paused") || log.action.includes("Hold") || log.action.includes("Alert")) actionColorClass = "text-red";
    else if (log.action.includes("Started")) actionColorClass = "text-blue";

    // Format role for display
    const displayRole = (log.role || "System").replace('_', ' ').toUpperCase();

    tr.innerHTML = `
      <td class="text-muted font-mono" style="width: 120px;">${formattedTime}</td>
      <td><strong>${log.user}</strong></td>
      <td><span class="badge badge-normal" style="font-size:9px;">${displayRole}</span></td>
      <td>${log.department}</td>
      <td class="font-mono text-cyan">${log.kpNumber}</td>
      <td class="${actionColorClass}">${log.action}</td>
    `;
    tbody.appendChild(tr);
  });
}

// 12. ACTIVE OPERATION STATE TRANSITIONS & TIMER WORKFLOW ACTIONS
function openAssignModal(kpNumber) {
  const modal = document.getElementById("modal-assign-operator");
  const kpDisplay = document.getElementById("modal-kp-display");
  const opButtonsContainer = document.getElementById("modal-operator-buttons");
  
  kpDisplay.textContent = kpNumber;

  // Set default selection from header selects
  const logged = getLoggedUser();
  selectedOperatorName = logged.name;
  selectedShiftName = logged.shift;

  // Render Operator Touch Buttons
  opButtonsContainer.innerHTML = "";
  operators.forEach(op => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "touch-select-btn";
    if (op.name === selectedOperatorName) {
      btn.classList.add("active");
    }
    btn.textContent = op.name;
    btn.addEventListener("click", () => {
      opButtonsContainer.querySelectorAll(".touch-select-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      selectedOperatorName = op.name;
    });
    opButtonsContainer.appendChild(btn);
  });

  // Shift Buttons highlights
  const shiftContainer = document.getElementById("modal-shift-buttons");
  if (shiftContainer) {
    shiftContainer.querySelectorAll(".touch-select-btn").forEach(btn => {
      const shiftVal = btn.getAttribute("data-shift");
      if (shiftVal === selectedShiftName) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
      
      btn.onclick = () => {
        shiftContainer.querySelectorAll(".touch-select-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        selectedShiftName = shiftVal;
      };
    });
  }

  modal.classList.add("active");
}

function closeAssignModal() {
  document.getElementById("modal-assign-operator").classList.remove("active");
}

function selectActiveJob(kpNumber) {
  selectedJobKp = kpNumber;
  renderMaskingDashboard();
}

async function startMaskingCycle(kpNumber, opName, shiftName) {
  const now = new Date().toISOString();
  const payload = {
    type: "START_CYCLE",
    kpNo: kpNumber,
    stage: "Masking",
    operatorName: opName,
    shift: shiftName,
    startTime: now,
    holdHistory: []
  };

  // Optimistic UI mutation
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (job) {
    job.masking = job.masking || {};
    job.masking.status = "In Progress";
    job.masking.operatorName = opName;
    job.masking.shift = shiftName;
    job.masking.startTime = now;
    job.masking.lastStartedAt = now;
    job.masking.holdHistory = [];
    job.masking.activeTimeMs = 0;
  }

  selectedJobKp = kpNumber;
  closeAssignModal();
  switchToSubtab("masking-subtab-active");
  renderAll();

  // Background sync
  pendingSyncCount++;
  sendBackendPost(payload)
    .then(() => {
      pendingSyncCount--;
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    })
    .catch(err => {
      pendingSyncCount--;
      console.error("Failed to sync start cycle:", err);
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    });
}

function pauseMaskingCycle() {
  if (!selectedJobKp) return;
  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job || job.masking.status !== "In Progress") {
    alert("Job must be actively running in progress to place it on hold.");
    return;
  }
  
  const modal = document.getElementById("modal-pause-masking");
  if (modal) {
    document.getElementById("modal-pause-kp-display").textContent = job.kpNumber;
    document.getElementById("pause-reason-select").value = "";
    document.getElementById("pause-remarks").value = "";
    modal.classList.add("active");
  }
}

function closePauseMaskingModal() {
  const modal = document.getElementById("modal-pause-masking");
  if (modal) modal.classList.remove("active");
}

async function submitPauseMasking(e) {
  if (e) e.preventDefault();
  if (!selectedJobKp) return;
  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job || job.masking.status !== "In Progress") return;

  const reason = document.getElementById("pause-reason-select").value;
  if (!reason) {
    alert("Please select a hold reason.");
    return;
  }

  const remarks = document.getElementById("pause-remarks").value;
  const now = new Date();

  // Calculate elapsed
  let elapsed = 0;
  if (job.masking.lastStartedAt) {
    elapsed = now.getTime() - new Date(job.masking.lastStartedAt).getTime();
  }
  const finalActiveTimeMs = (job.masking.activeTimeMs || 0) + elapsed;

  // Build Hold Record
  const newHoldRecord = {
    holdTime: now.toISOString(),
    resumeTime: null,
    reason: reason,
    notes: remarks
  };
  const updatedHoldHistory = [...(job.masking.holdHistory || []), newHoldRecord];

  const payload = {
    type: "PAUSE_CYCLE",
    kpNo: selectedJobKp,
    stage: "Masking",
    operatorName: getLoggedUser().name,
    activeTimeMs: finalActiveTimeMs,
    holdHistory: updatedHoldHistory,
    holdReason: reason
  };

  // Optimistic UI mutation
  job.masking.status = "Hold";
  job.masking.activeTimeMs = finalActiveTimeMs;
  job.masking.lastPausedAt = now.toISOString();
  job.masking.holdHistory = updatedHoldHistory;

  closePauseMaskingModal();
  renderAll();

  // Background sync
  pendingSyncCount++;
  sendBackendPost(payload)
    .then(() => {
      pendingSyncCount--;
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    })
    .catch(err => {
      pendingSyncCount--;
      console.error("Failed to sync hold action:", err);
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    });
}

function resumeMaskingCycle() {
  submitResumeJob();
}

// Materials complete modal rendering & adjustments
function renderCompleteModalMaterials(job) {
  const container = document.getElementById("modal-complete-materials-container");
  if (!container) return;
  
  container.innerHTML = "";
  const jobMats = job.masking.materials || [];
  if (jobMats.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 10px;">No materials assigned to this job.</div>`;
    return;
  }
  
  jobMats.forEach((mat, idx) => {
    const div = document.createElement("div");
    div.style.marginBottom = "15px";
    div.style.borderBottom = "1px solid var(--border-color)";
    div.style.paddingBottom = "10px";
    div.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
        <span style="font-weight: bold; font-size: 14px;">${mat.name}</span>
        <span class="badge badge-normal" style="font-size: 11px;">${mat.unit}</span>
      </div>
      <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 5px;">
        Type: ${mat.type} | Batch: ${mat.batch} | Planned: ${mat.plannedQty}
      </div>
      <div style="display: flex; gap: 10px; align-items: center;">
        <label style="font-size: 13px;">Actual Used:</label>
        <div class="qty-adjust-container" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px;">
          <button type="button" class="btn-qty-adjust" onclick="adjustCompleteModalMaterialQty(${idx}, -1)" style="height: 38px; width: 38px; font-size: 18px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border-color); background: var(--bg-hover); color: var(--text-color); cursor: pointer; border-radius: 4px;">-</button>
          <input type="number" step="0.01" min="0" 
            value="${mat.actualQty || 0}" 
            class="qty-adjust-input font-mono" 
            id="modal-complete-mat-actual-input-${idx}"
            style="height: 38px; text-align: center; font-size: 16px; width: 80px; background: var(--bg-card); color: var(--text-color); border: 1px solid var(--border-color); border-radius: 4px;"
            onchange="updateCompleteModalMaterialQty(${idx}, this.value)">
          <button type="button" class="btn-qty-adjust" onclick="adjustCompleteModalMaterialQty(${idx}, 1)" style="height: 38px; width: 38px; font-size: 18px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border-color); background: var(--bg-hover); color: var(--text-color); cursor: pointer; border-radius: 4px;">+</button>
        </div>
      </div>
    `;
    container.appendChild(div);
  });
}

window.adjustCompleteModalMaterialQty = function(index, dir) {
  if (!selectedJobKp) return;
  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job) return;
  const mat = job.masking.materials[index];
  if (!mat) return;
  
  let step = 0.1;
  if (mat.unit.toLowerCase() === "gram" || mat.unit.toLowerCase() === "g" || mat.unit.toLowerCase() === "pc" || mat.unit.toLowerCase() === "pcs") {
    step = 10;
  }
  
  const currentVal = parseFloat(mat.actualQty) || 0;
  let newVal = currentVal + (dir * step);
  if (newVal < 0) newVal = 0;
  newVal = Math.round(newVal * 100) / 100;
  
  mat.actualQty = newVal;
  const input = document.getElementById(`modal-complete-mat-actual-input-${index}`);
  if (input) input.value = newVal;
  
  updateJobMaterialActual(selectedJobKp, index, newVal);
};

window.updateCompleteModalMaterialQty = function(index, val) {
  if (!selectedJobKp) return;
  const floatVal = parseFloat(val);
  const newVal = isNaN(floatVal) ? 0 : floatVal;
  updateJobMaterialActual(selectedJobKp, index, newVal);
};

// END MASKING CYCLE (OPENS COMPLETION MODAL)
function endMaskingCycle() {
  if (!selectedJobKp) return;
  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job) return;

  // Open the Complete Masking Modal directly and render materials inputs inside
  const modal = document.getElementById("modal-complete-masking");
  document.getElementById("modal-complete-kp-display").textContent = job.kpNumber;
  
  // Set default next process from the static dropdown value or default to Spraying
  const staticSelect = document.getElementById("masking-next-process");
  const defaultNext = staticSelect ? staticSelect.value : "Spraying";
  document.getElementById("masking-complete-next-process").value = defaultNext;

  renderCompleteModalMaterials(job);

  modal.classList.add("active");
}

function closeCompleteMaskingModal() {
  document.getElementById("modal-complete-masking").classList.remove("active");
}

async function submitCompleteMasking(e) {
  if (e) e.preventDefault();
  if (!selectedJobKp) return;
  const job = jobs.find(j => j.kpNumber === selectedJobKp);
  if (!job) return;

  // Confirm materials validation upon clicking submit inside the modal
  let missingActuals = false;
  job.masking.materials.forEach(mat => {
    if (mat.actualQty === 0 || mat.actualQty === "0" || isNaN(parseFloat(mat.actualQty))) {
      missingActuals = true;
    }
  });

  if (missingActuals) {
    if (!confirm("One or more material line items have actual quantity equal to zero. Do you want to submit anyway?")) {
      return;
    }
  }

  const now = new Date();
  
  // Calculate final elapsed runtime before stopping
  let finalActiveMs = job.masking.activeTimeMs || 0;
  if (job.masking.status === "In Progress" && job.masking.lastStartedAt) {
    finalActiveMs += (now.getTime() - new Date(job.masking.lastStartedAt).getTime());
  }

  // Get next process from complete modal
  const nextDept = document.getElementById("masking-complete-next-process").value || "Spraying";

  const payload = {
    type: "END_CYCLE",
    kpNo: selectedJobKp,
    stage: "Masking",
    operatorName: job.masking.operatorName || getLoggedUser().name,
    endTime: now.toISOString(),
    activeTimeMs: finalActiveMs,
    nextStage: nextDept,
    holdHistory: job.masking.holdHistory || []
  };

  // Optimistic UI mutation
  job.masking.status = "Completed";
  job.masking.endTime = now.toISOString();
  job.masking.durationMs = finalActiveMs;
  
  transitionToStage(job, nextDept, job.masking.operatorName || getLoggedUser().name);

  // Refresh spraying iframe if active
  const sprayingIframe = document.getElementById("spraying-iframe");
  if (sprayingIframe && sprayingIframe.contentWindow) {
    sprayingIframe.contentWindow.dispatchEvent(new CustomEvent("refresh-spraying-data"));
  }

  selectedJobKp = null;
  closeCompleteMaskingModal();
  renderAll();

  // Background sync
  pendingSyncCount++;
  sendBackendPost(payload)
    .then(() => {
      pendingSyncCount--;
      // Force refreshing spraying iframe once backend has finalized the stage change
      if (sprayingIframe && sprayingIframe.contentWindow) {
        sprayingIframe.contentWindow.dispatchEvent(new CustomEvent("refresh-spraying-data"));
      }
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    })
    .catch(err => {
      pendingSyncCount--;
      console.error("Failed to sync completed masking cycle:", err);
      if (pendingSyncCount === 0) {
        return loadState().then(() => renderAll());
      }
    });
}


// ==================== STAGE DASHBOARDS & USER MANAGEMENT (NEW STAGES & CRUD) ====================

function renderGrindingDashboard() {
  const tbody = document.getElementById("grinding-queue-list");
  if (!tbody) return;
  tbody.innerHTML = "";
  
  const grindingJobs = jobs.filter(j => j.currentDepartment === "Grinding");
  if (grindingJobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No components in grinding stage.</td></tr>`;
    return;
  }
  
  const isReadOnly = (currentUser && currentUser.role === 'hr_admin');
  
  grindingJobs.forEach(job => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="font-mono font-bold text-cyan">${job.kpNumber}</td>
      <td>${job.partName}</td>
      <td>${job.customer}</td>
      <td class="font-mono">${job.quantity}</td>
      <td><span class="badge badge-pending">Grinding Pending</span></td>
      <td>${job.priority}</td>
      <td>
        <select id="grinding-next-stage-${job.kpNumber}" class="form-input select-sm" style="display:inline-block; width:auto; margin-right:5px; height:30px; padding:2px 5px; font-size:12px;" ${isReadOnly ? 'disabled style="display:none;"' : ''}>
          <option value="Inspection">Inspection</option>
          <option value="Masking">Masking</option>
          <option value="Spraying">Spraying</option>
          <option value="Grinding">Grinding</option>
          <option value="Polishing" selected>Polishing</option>
          <option value="Final Inspection">Final Inspection</option>
          <option value="Dispatch">Dispatch</option>
        </select>
        <button class="btn btn-success btn-xs" onclick="progressGrindingJob('${job.kpNumber}')" ${isReadOnly ? 'disabled style="display:none;"' : ''}>Complete Grinding</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function progressGrindingJob(kpNumber) {
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (job) {
    const selectEl = document.getElementById(`grinding-next-stage-${kpNumber}`);
    const nextDept = selectEl ? selectEl.value : "Polishing";
    
    const payload = {
      type: "END_CYCLE",
      kpNo: kpNumber,
      stage: "Grinding",
      operatorName: getLoggedUser().name,
      endTime: new Date().toISOString(),
      activeTimeMs: 0,
      nextStage: nextDept
    };
    
    // Optimistic UI mutation
    transitionToStage(job, nextDept, getLoggedUser().name);
    renderAll();

    // Background sync
    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync grinding progression:", err);
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      });
  }
}

function setupGrindingSubtabs() {
  const subtabButtons = document.querySelectorAll(".grinding-tab-btn");
  const subtabPanels = document.querySelectorAll(".grinding-subtab-panel");

  subtabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetSubtab = btn.getAttribute("data-subtab");
      if (!targetSubtab) return;

      activeGrindingSubtab = targetSubtab;
      
      subtabButtons.forEach(b => b.classList.remove("active"));
      subtabPanels.forEach(p => p.classList.remove("active"));

      btn.classList.add("active");
      const targetPanel = document.getElementById(targetSubtab);
      if (targetPanel) targetPanel.classList.add("active");

      renderGrindingDashboard();
    });
  });
}

function switchToGrindingSubtab(subtabId) {
  activeGrindingSubtab = subtabId;
  const subtabButtons = document.querySelectorAll(".grinding-tab-btn");
  const subtabPanels = document.querySelectorAll(".grinding-subtab-panel");



  subtabButtons.forEach(btn => {
    if (btn.getAttribute("data-subtab") === subtabId) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  subtabPanels.forEach(panel => {
    if (panel.id === subtabId) {
      panel.classList.add("active");
    } else {
      panel.classList.remove("active");
    }
  });
}

function renderGrindingDashboard() {
  renderGrindingKpis();
  renderGrindingLiveQueue();
  renderGrindingActiveJobTimer();
  renderGrindingActiveCards();
  renderGrindingHistory();
}

function renderGrindingKpis() {
  const pending = jobs.filter(j => j.currentDepartment === "Grinding" && j.grinding?.status === "Pending").length;
  const running = jobs.filter(j => j.currentDepartment === "Grinding" && j.grinding?.status === "In Progress").length;
  const completed = jobs.filter(j => j.grinding?.status === "Completed").length;
  
  const runningJobs = jobs.filter(j => j.currentDepartment === "Grinding" && j.grinding?.status === "In Progress");
  const machines = new Set(runningJobs.map(j => j.grinding?.machineName).filter(Boolean));
  
  const completedGrindingJobs = jobs.filter(j => j.grinding?.status === "Completed");
  let avgCycleStr = "00:00:00";
  if (completedGrindingJobs.length > 0) {
    const totalDuration = completedGrindingJobs.reduce((sum, j) => sum + (j.grinding?.durationMs || 0), 0);
    const avgMs = totalDuration / completedGrindingJobs.length;
    avgCycleStr = formatDuration(avgMs);
  }

  const pEl = document.getElementById("grinding-kpis-pending");
  const rEl = document.getElementById("grinding-kpis-running");
  const mEl = document.getElementById("grinding-kpis-machines");
  const cEl = document.getElementById("grinding-kpis-completed");
  const aEl = document.getElementById("grinding-kpis-avgtime");

  if (pEl) pEl.textContent = pending;
  if (rEl) rEl.textContent = running;
  if (mEl) mEl.textContent = machines.size;
  if (cEl) cEl.textContent = completed;
  if (aEl) aEl.textContent = avgCycleStr;
}

function renderGrindingLiveQueue() {
  const cardsContainer = document.getElementById("grinding-queue-cards");
  if (!cardsContainer) return;
  cardsContainer.innerHTML = "";

  const filterKp = document.getElementById("grinding-filter-kp").value.toLowerCase();
  const filterCust = document.getElementById("grinding-filter-customer").value.toLowerCase();
  const filterMach = document.getElementById("grinding-filter-machine").value;
  const filterProc = document.getElementById("grinding-filter-process").value;

  const queueJobs = jobs.filter(j => {
    if (j.currentDepartment !== "Grinding" || j.grinding?.status === "Completed") return false;
    
    if (filterKp && !j.kpNumber.toLowerCase().includes(filterKp)) return false;
    if (filterCust && !j.customer.toLowerCase().includes(filterCust)) return false;
    if (filterMach && j.grinding?.machineName !== filterMach) return false;
    if (filterProc && j.grinding?.processType !== filterProc) return false;
    
    return true;
  });

  if (queueJobs.length === 0) {
    cardsContainer.innerHTML = `<div class="no-selection-message" style="grid-column: 1 / -1; width: 100%;">No jobs match the queue filters.</div>`;
    return;
  }

  queueJobs.forEach(job => {
    const card = document.createElement("div");
    card.className = "job-queue-card";
    
    let statusClass = "badge-pending";
    if (job.grinding.status === "In Progress") statusClass = "badge-progress";
    else if (job.grinding.status === "Hold") statusClass = "badge-hold";

    let priorityClass = "";
    if (job.priority === "Critical") priorityClass = "text-red font-bold";
    else if (job.priority === "High") priorityClass = "text-orange";

    let actionButton = "";
    if (job.grinding.status === "Pending") {
      actionButton = `<button class="btn btn-success btn-tablet-primary" onclick="openStartGrindingModal('${job.kpNumber}')">START GRINDING</button>`;
    } else {
      actionButton = `<button class="btn btn-primary btn-tablet-primary" onclick="selectActiveGrindingJobAndSwitch('${job.kpNumber}')">VIEW STATION</button>`;
    }

    card.innerHTML = `
      <div class="job-card-header">
        <span class="job-card-kp">${job.kpNumber}</span>
        <span class="badge ${statusClass}">${job.grinding.status}</span>
      </div>
      <div class="job-card-body">
        <div class="job-card-row">
          <span class="job-card-label">Part Name:</span>
          <span class="job-card-value">${job.partName}</span>
        </div>
        <div class="job-card-row">
          <span class="job-card-label">Customer:</span>
          <span class="job-card-value">${job.customer}</span>
        </div>
        <div class="job-card-row">
          <span class="job-card-label">Quantity:</span>
          <span class="job-card-value font-mono">${job.grinding.quantity || job.quantity} pcs</span>
        </div>
        <div class="job-card-row">
          <span class="job-card-label">Machine:</span>
          <span class="job-card-value">${job.grinding.machineName || "Unassigned"}</span>
        </div>
        <div class="job-card-row">
          <span class="job-card-label">Process Stage:</span>
          <span class="job-card-value">${job.grinding.processType || "Unassigned"}</span>
        </div>
        <div class="job-card-row">
          <span class="job-card-label">Store Location:</span>
          <span class="job-card-value text-orange">${job.grinding.storeLocation || "N/A"}</span>
        </div>
      </div>
      <div class="job-card-actions">
        ${actionButton}
      </div>
    `;
    cardsContainer.appendChild(card);
  });
}

function selectActiveGrindingJobAndSwitch(kpNumber) {
  selectedGrindingJobKp = kpNumber;
  switchToGrindingSubtab("grinding-subtab-active");
  renderGrindingDashboard();
}

function renderGrindingActiveJobTimer() {
  const container = document.getElementById("grinding-active-job-timer-interface");
  const noJobMsg = document.getElementById("grinding-no-active-job-message");

  if (!selectedGrindingJobKp) {
    if (container) container.style.display = "none";
    if (noJobMsg) noJobMsg.style.display = "flex";
    return;
  }

  const job = jobs.find(j => j.kpNumber === selectedGrindingJobKp);
  if (!job || job.currentDepartment !== "Grinding" || job.grinding?.status === "Completed") {
    selectedGrindingJobKp = null;
    if (container) container.style.display = "none";
    if (noJobMsg) noJobMsg.style.display = "flex";
    return;
  }

  if (noJobMsg) noJobMsg.style.display = "none";
  if (container) container.style.display = "flex";

  document.getElementById("grinding-active-kp-no").textContent = job.kpNumber;
  document.getElementById("grinding-active-part-name").textContent = job.partName;
  document.getElementById("grinding-active-customer").textContent = job.customer;
  document.getElementById("grinding-active-qty").textContent = job.grinding.quantity || job.quantity;
  document.getElementById("grinding-active-machine").textContent = job.grinding.machineName || "Unassigned";
  document.getElementById("grinding-active-process").textContent = job.grinding.processType || "Unassigned";
  document.getElementById("grinding-active-location").textContent = job.grinding.storeLocation || "N/A";

  const statusBadge = document.getElementById("grinding-active-cycle-status-badge");
  statusBadge.className = "badge";
  if (job.grinding.status === "In Progress") {
    statusBadge.classList.add("badge-progress");
    statusBadge.textContent = "RUNNING";
  } else if (job.grinding.status === "Hold") {
    statusBadge.classList.add("badge-hold");
    statusBadge.textContent = "ON HOLD";
  } else {
    statusBadge.classList.add("badge-normal");
    statusBadge.textContent = "STANDBY";
  }

  document.getElementById("grinding-operator-remarks").value = job.grinding.remarks || "";
  document.getElementById("grinding-quality-remarks").value = job.grinding.qualityRemarks || "";
  document.getElementById("grinding-notes").value = job.grinding.notes || "";

  const btnStart = document.getElementById("btn-grinding-start-cycle");
  const btnPause = document.getElementById("btn-grinding-pause-cycle");
  const btnResume = document.getElementById("btn-grinding-resume-cycle");
  const btnEnd = document.getElementById("btn-grinding-end-cycle");

  if (job.grinding.status === "Pending") {
    btnStart.style.display = "block";
    btnPause.style.display = "none";
    btnResume.style.display = "none";
    btnEnd.style.display = "none";
  } else if (job.grinding.status === "In Progress") {
    btnStart.style.display = "none";
    btnPause.style.display = "block";
    btnResume.style.display = "none";
    btnEnd.style.display = "block";
  } else if (job.grinding.status === "Hold") {
    btnStart.style.display = "none";
    btnPause.style.display = "none";
    btnResume.style.display = "block";
    btnEnd.style.display = "block";
  }

  updateGrindingTimerReadout(job);
}

function renderGrindingActiveCards() {
  const container = document.getElementById("grinding-active-job-cards-container");
  if (!container) return;
  container.innerHTML = "";

  const activeJobs = jobs.filter(j => j.currentDepartment === "Grinding" && j.grinding?.status !== "Pending" && j.grinding?.status !== "Completed");

  if (activeJobs.length === 0) {
    container.innerHTML = `<div class="no-selection-message">No running grinding cycles on the shop floor.</div>`;
    return;
  }

  activeJobs.forEach(job => {
    const card = document.createElement("div");
    card.className = "active-card";
    if (job.kpNumber === selectedGrindingJobKp) {
      card.classList.add("selected-card");
    }

    card.addEventListener("click", () => {
      selectedGrindingJobKp = job.kpNumber;
      renderGrindingDashboard();
    });

    let statusBadgeClass = "badge-progress";
    if (job.grinding.status === "Hold") statusBadgeClass = "badge-hold";

    let runningMs = job.grinding.activeTimeMs || 0;
    if (job.grinding.status === "In Progress" && job.grinding.lastStartedAt) {
      const start = new Date(job.grinding.lastStartedAt).getTime();
      const now = new Date().getTime();
      runningMs += (now - start);
    }

    card.innerHTML = `
      <div class="card-left">
        <div class="card-kp-row">
          <span class="card-kp">${job.kpNumber}</span>
          <span class="badge ${statusBadgeClass} text-xs">${job.grinding.status}</span>
        </div>
        <span class="card-part">${job.partName} (${job.grinding.quantity || job.quantity} pcs)</span>
        <span class="card-op-info">Machine: ${job.grinding.machineName}</span>
      </div>
      <div class="card-right">
        <span class="card-time font-mono">${formatDuration(runningMs)}</span>
        <span class="text-xs text-muted">Active Run</span>
      </div>
    `;
    container.appendChild(card);
  });
}

function renderGrindingHistory() {
  const tbody = document.getElementById("grinding-history-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const filterKp = document.getElementById("grinding-hist-filter-kp").value.toLowerCase();
  const filterCust = document.getElementById("grinding-hist-filter-customer").value.toLowerCase();
  const filterMach = document.getElementById("grinding-hist-filter-machine").value.toLowerCase();
  const filterProc = document.getElementById("grinding-hist-filter-process").value;

  const historyJobs = jobs.filter(j => {
    if (j.grinding?.status !== "Completed") return false;
    
    if (filterKp && !j.kpNumber.toLowerCase().includes(filterKp)) return false;
    if (filterCust && !j.customer.toLowerCase().includes(filterCust)) return false;
    if (filterMach && !j.grinding.machineName.toLowerCase().includes(filterMach)) return false;
    if (filterProc && j.grinding.processType !== filterProc) return false;
    
    return true;
  });

  if (historyJobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted">No completed grinding records.</td></tr>`;
    return;
  }

  historyJobs.forEach(job => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="font-mono font-bold text-cyan">${job.kpNumber}</td>
      <td>${job.partName}</td>
      <td>${job.customer}</td>
      <td class="font-mono">${job.grinding.quantity || job.quantity}</td>
      <td>${job.grinding.machineName}</td>
      <td>${job.grinding.processType}</td>
      <td>${job.grinding.storeLocation || "N/A"}</td>
      <td class="font-mono">${formatDuration(job.grinding.durationMs)}</td>
      <td><strong>${job.grinding.nextProcess || "Polishing"}</strong></td>
    `;
    tbody.appendChild(tr);
  });
}

function openStartGrindingModal(kpNumber) {
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (!job) return;

  document.getElementById("modal-grinding-kp-display").textContent = kpNumber;
  document.getElementById("grinding-machine-select").value = "";
  document.getElementById("grinding-process-select").value = "Pre Grinding";
  document.getElementById("grinding-qty-input").value = job.quantity;
  document.getElementById("grinding-location-select").value = "C20";

  document.getElementById("modal-start-grinding").classList.add("active");
}

function closeGrindingStartModal() {
  document.getElementById("modal-start-grinding").classList.remove("active");
}

function closeGrindingPauseModal() {
  document.getElementById("modal-pause-grinding").classList.remove("active");
}

function closeGrindingCompleteModal() {
  document.getElementById("modal-complete-grinding").classList.remove("active");
}

function submitStartGrinding(e) {
  e.preventDefault();
  const kp = document.getElementById("modal-grinding-kp-display").textContent;
  const machine = document.getElementById("grinding-machine-select").value;
  const process = document.getElementById("grinding-process-select").value;
  const qty = parseInt(document.getElementById("grinding-qty-input").value);
  const locationVal = document.getElementById("grinding-location-select").value;

  if (!machine) {
    alert("Machine selection is mandatory.");
    return;
  }

  startGrindingCycle(kp, machine, process, qty, locationVal);
}

function startGrindingCycle(kp, machine, process, qty, locationVal) {
  const job = jobs.find(j => j.kpNumber === kp);
  if (job) {
    const now = new Date();
    
    job.grinding.status = "In Progress";
    job.grinding.machineName = machine;
    job.grinding.processType = process;
    job.grinding.quantity = qty;
    job.grinding.storeLocation = locationVal;
    job.grinding.startTime = now.toISOString();
    job.grinding.lastStartedAt = now.toISOString();
    job.grinding.operatorName = currentUser?.email || "Operator";
    
    selectedGrindingJobKp = kp;
    closeGrindingStartModal();
    switchToGrindingSubtab("grinding-subtab-active");
    renderAll();

    createAuditLog(currentUser.email, kp, `Started Grinding cycle for ${kp} using Machine ${machine} (${process}) at ${locationVal}`);

    const payload = {
      type: "START_CYCLE",
      kpNo: kp,
      stage: "Grinding",
      operatorName: currentUser.email,
      startTime: now.toISOString(),
      machineName: machine,
      processType: process,
      quantity: qty,
      storeLocation: locationVal
    };

    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync grinding cycle start:", err);
      });
  }
}

function pauseGrindingCycle() {
  if (!selectedGrindingJobKp) return;
  document.getElementById("modal-pause-grinding-kp-display").textContent = selectedGrindingJobKp;
  document.getElementById("grinding-pause-reason-select").value = "";
  document.getElementById("grinding-pause-remarks").value = "";
  document.getElementById("modal-pause-grinding").classList.add("active");
}

function submitPauseGrinding(e) {
  e.preventDefault();
  const kp = selectedGrindingJobKp;
  const reason = document.getElementById("grinding-pause-reason-select").value;
  const remarks = document.getElementById("grinding-pause-remarks").value;

  if (!reason) {
    alert("Please select a hold reason.");
    return;
  }

  const job = jobs.find(j => j.kpNumber === kp);
  if (job && job.grinding.status === "In Progress") {
    const now = new Date();
    
    let activeMs = job.grinding.activeTimeMs || 0;
    if (job.grinding.lastStartedAt) {
      activeMs += (now.getTime() - new Date(job.grinding.lastStartedAt).getTime());
    }
    
    job.grinding.status = "Hold";
    job.grinding.activeTimeMs = activeMs;
    job.grinding.lastPausedAt = now.toISOString();
    job.grinding.lastStartedAt = null;
    
    const holdInst = {
      holdTime: now.toISOString(),
      resumeTime: null,
      reason: reason,
      remarks: remarks
    };
    job.grinding.holdHistory = job.grinding.holdHistory || [];
    job.grinding.holdHistory.push(holdInst);

    closeGrindingPauseModal();
    renderAll();

    createAuditLog(currentUser.email, kp, `Paused Grinding cycle. Reason: ${reason}. Remarks: ${remarks}`);

    const payload = {
      type: "PAUSE_CYCLE",
      kpNo: kp,
      stage: "Grinding",
      operatorName: currentUser.email,
      pauseTime: now.toISOString(),
      reason: reason,
      remarks: remarks,
      activeTimeMs: activeMs
    };

    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync grinding pause cycle:", err);
      });
  }
}

function resumeGrindingCycle() {
  if (!selectedGrindingJobKp) return;
  const kp = selectedGrindingJobKp;
  const job = jobs.find(j => j.kpNumber === kp);
  if (job && job.grinding.status === "Hold") {
    const now = new Date();
    
    job.grinding.status = "In Progress";
    job.grinding.lastStartedAt = now.toISOString();
    
    if (job.grinding.holdHistory && job.grinding.holdHistory.length > 0) {
      const lastHold = job.grinding.holdHistory[job.grinding.holdHistory.length - 1];
      lastHold.resumeTime = now.toISOString();
    }

    renderAll();

    createAuditLog(currentUser.email, kp, `Resumed Grinding cycle`);

    const payload = {
      type: "RESUME_CYCLE",
      kpNo: kp,
      stage: "Grinding",
      operatorName: currentUser.email,
      resumeTime: now.toISOString()
    };

    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync grinding resume cycle:", err);
      });
  }
}

function endGrindingCycle() {
  if (!selectedGrindingJobKp) return;
  document.getElementById("modal-complete-grinding-kp-display").textContent = selectedGrindingJobKp;
  document.getElementById("grinding-complete-next-process").value = "Polishing";
  document.getElementById("modal-complete-grinding").classList.add("active");
}

function submitCompleteGrinding(e) {
  e.preventDefault();
  const kp = selectedGrindingJobKp;
  const nextDept = document.getElementById("grinding-complete-next-process").value || "Polishing";

  const job = jobs.find(j => j.kpNumber === kp);
  if (job) {
    const now = new Date();
    
    job.grinding.remarks = document.getElementById("grinding-operator-remarks").value;
    job.grinding.qualityRemarks = document.getElementById("grinding-quality-remarks").value;
    job.grinding.notes = document.getElementById("grinding-notes").value;
    
    let activeMs = job.grinding.activeTimeMs || 0;
    if (job.grinding.status === "In Progress" && job.grinding.lastStartedAt) {
      activeMs += (now.getTime() - new Date(job.grinding.lastStartedAt).getTime());
    }

    job.grinding.status = "Completed";
    job.grinding.endTime = now.toISOString();
    job.grinding.durationMs = activeMs;
    job.grinding.nextProcess = nextDept;

    transitionToStage(job, nextDept, currentUser.email);
    selectedGrindingJobKp = null;
    closeGrindingCompleteModal();
    renderAll();

    createAuditLog(currentUser.email, kp, `Completed Grinding stage and moved component to ${nextDept} Department`);

    const payload = {
      type: "END_CYCLE",
      kpNo: kp,
      stage: "Grinding",
      operatorName: currentUser.email,
      endTime: now.toISOString(),
      activeTimeMs: activeMs,
      nextStage: nextDept,
      remarks: job.grinding.remarks,
      qualityRemarks: job.grinding.qualityRemarks,
      notes: job.grinding.notes
    };

    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync completed grinding job:", err);
      });
  }
}

// Expose grinding functions to window context
window.openStartGrindingModal = openStartGrindingModal;
window.selectActiveGrindingJobAndSwitch = selectActiveGrindingJobAndSwitch;

function renderPolishingDashboard() {
  const tbody = document.getElementById("polishing-queue-list");
  if (!tbody) return;
  tbody.innerHTML = "";
  
  const polishingJobs = jobs.filter(j => j.currentDepartment === "Polishing");
  if (polishingJobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No components in polishing stage.</td></tr>`;
    return;
  }
  
  const isReadOnly = (currentUser && currentUser.role === 'hr_admin');
  
  polishingJobs.forEach(job => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="font-mono font-bold text-cyan">${job.kpNumber}</td>
      <td>${job.partName}</td>
      <td>${job.customer}</td>
      <td class="font-mono">${job.quantity}</td>
      <td><span class="badge badge-pending">Polishing Pending</span></td>
      <td>${job.priority}</td>
      <td>
        <select id="polishing-next-stage-${job.kpNumber}" class="form-input select-sm" style="display:inline-block; width:auto; margin-right:5px; height:30px; padding:2px 5px; font-size:12px;" ${isReadOnly ? 'disabled style="display:none;"' : ''}>
          <option value="Inspection">Inspection</option>
          <option value="Masking">Masking</option>
          <option value="Spraying">Spraying</option>
          <option value="Grinding">Grinding</option>
          <option value="Polishing">Polishing</option>
          <option value="Final Inspection" selected>Final Inspection</option>
          <option value="Dispatch">Dispatch</option>
        </select>
        <button class="btn btn-success btn-xs" onclick="progressPolishingJob('${job.kpNumber}')" ${isReadOnly ? 'disabled style="display:none;"' : ''}>Complete Polishing</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function progressPolishingJob(kpNumber) {
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (job) {
    const selectEl = document.getElementById(`polishing-next-stage-${kpNumber}`);
    const nextDept = selectEl ? selectEl.value : "Final Inspection";
    
    const payload = {
      type: "END_CYCLE",
      kpNo: kpNumber,
      stage: "Polishing",
      operatorName: getLoggedUser().name,
      endTime: new Date().toISOString(),
      activeTimeMs: 0,
      nextStage: nextDept
    };
    
    // Optimistic UI mutation
    transitionToStage(job, nextDept, getLoggedUser().name);
    renderAll();

    // Background sync
    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync polishing progression:", err);
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      });
  }
}

function renderFinalInspectionDashboard() {
  const tbody = document.getElementById("final-inspection-queue-list");
  if (!tbody) return;
  tbody.innerHTML = "";
  
  const finalJobs = jobs.filter(j => j.currentDepartment === "Final Inspection");
  if (finalJobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No components in final inspection queue.</td></tr>`;
    return;
  }
  
  const isReadOnly = (currentUser && currentUser.role === 'hr_admin');
  
  finalJobs.forEach(job => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="font-mono font-bold text-cyan">${job.kpNumber}</td>
      <td>${job.partName}</td>
      <td>${job.customer}</td>
      <td class="font-mono">${job.quantity}</td>
      <td><span class="badge badge-pending">QA Review Pending</span></td>
      <td>${job.priority}</td>
      <td>
        <select id="final-inspection-next-stage-${job.kpNumber}" class="form-input select-sm" style="display:inline-block; width:auto; margin-right:5px; height:30px; padding:2px 5px; font-size:12px;" ${isReadOnly ? 'disabled style="display:none;"' : ''}>
          <option value="Inspection">Inspection</option>
          <option value="Masking">Masking</option>
          <option value="Spraying">Spraying</option>
          <option value="Grinding">Grinding</option>
          <option value="Polishing">Polishing</option>
          <option value="Final Inspection">Final Inspection</option>
          <option value="Dispatch" selected>Dispatch</option>
        </select>
        <button class="btn btn-success btn-xs" onclick="progressFinalInspectionJob('${job.kpNumber}')" ${isReadOnly ? 'disabled style="display:none;"' : ''}>Approve QA & Close</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function progressFinalInspectionJob(kpNumber) {
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (job) {
    const selectEl = document.getElementById(`final-inspection-next-stage-${kpNumber}`);
    const nextDept = selectEl ? selectEl.value : "Dispatch";
    
    const payload = {
      type: "END_CYCLE",
      kpNo: kpNumber,
      stage: "Final Inspection",
      operatorName: getLoggedUser().name,
      endTime: new Date().toISOString(),
      activeTimeMs: 0,
      nextStage: nextDept
    };
    
    // Optimistic UI mutation
    transitionToStage(job, nextDept, getLoggedUser().name);
    renderAll();

    // Background sync
    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync final inspection progression:", err);
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      });
  }
}

function renderDispatchDashboard() {
  const tbody = document.getElementById("dispatch-queue-list");
  if (!tbody) return;
  tbody.innerHTML = "";
  
  const dispatchJobs = jobs.filter(j => j.currentDepartment === "Dispatch");
  if (dispatchJobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No components ready for dispatch.</td></tr>`;
    return;
  }
  
  const isReadOnly = (currentUser && (currentUser.role === 'hr_admin' || currentUser.role === 'quality_admin'));
  
  dispatchJobs.forEach(job => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="font-mono font-bold text-cyan">${job.kpNumber}</td>
      <td>${job.partName}</td>
      <td>${job.customer}</td>
      <td class="font-mono">${job.quantity}</td>
      <td><span class="badge badge-completed">Ready for Dispatch</span></td>
      <td>${job.priority}</td>
      <td>
        <select id="dispatch-next-stage-${job.kpNumber}" class="form-input select-sm" style="display:inline-block; width:auto; margin-right:5px; height:30px; padding:2px 5px; font-size:12px;" ${isReadOnly ? 'disabled style="display:none;"' : ''}>
          <option value="Inspection">Inspection</option>
          <option value="Masking">Masking</option>
          <option value="Spraying">Spraying</option>
          <option value="Grinding">Grinding</option>
          <option value="Polishing">Polishing</option>
          <option value="Final Inspection">Final Inspection</option>
          <option value="Dispatch">Dispatch</option>
          <option value="Dispatched" selected>Dispatched (Complete)</option>
        </select>
        <button class="btn btn-success btn-xs" onclick="progressDispatchJob('${job.kpNumber}')" ${isReadOnly ? 'disabled style="display:none;"' : ''}>Dispatch Job</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function progressDispatchJob(kpNumber) {
  const job = jobs.find(j => j.kpNumber === kpNumber);
  if (job) {
    const selectEl = document.getElementById(`dispatch-next-stage-${kpNumber}`);
    const nextDept = selectEl ? selectEl.value : "Dispatched";
    
    const payload = {
      type: "END_CYCLE",
      kpNo: kpNumber,
      stage: "Dispatch",
      operatorName: getLoggedUser().name,
      endTime: new Date().toISOString(),
      activeTimeMs: 0,
      nextStage: nextDept
    };
    
    // Optimistic UI mutation
    transitionToStage(job, nextDept, getLoggedUser().name);
    if (nextDept === "Dispatched") {
      job.status = "Completed";
    }
    renderAll();

    // Background sync
    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync dispatch progression:", err);
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      });
  }
}

// User Management Renderer (Super Admin only)
async function renderUserManagement() {
  const tbody = document.getElementById("user-management-table-body");
  if (!tbody) return;
  
  const isMock = !firebaseConfig.apiKey || firebaseConfig.apiKey.includes("YOUR_FIREBASE_") || localStorage.getItem("psp_auth_mock") === "true";
  let users = [];
  
  if (!isMock && typeof firebase !== 'undefined' && firebase.firestore) {
    try {
      const db = firebase.firestore();
      const snapshot = await db.collection("users").get();
      snapshot.forEach(doc => {
        users.push(doc.data());
      });
    } catch (err) {
      console.warn("Could not fetch Firestore users, using Mock DB backup:", err);
      users = MOCK_DB.getUsers();
    }
  } else {
    users = MOCK_DB.getUsers();
  }

  renderUserRows(users);
}

function renderUserRows(users) {
  const tbody = document.getElementById("user-management-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";
  
  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No registered users in system.</td></tr>`;
    return;
  }
  
  users.forEach(user => {
    const tr = document.createElement("tr");
    
    // Status text & badge
    let statusText = "Pending Approval";
    let badgeClass = "badge-pending";
    if (user.active) {
      statusText = "Active";
      badgeClass = "badge-completed";
    } else if (user.role && user.role !== "pending" && user.role !== "Pending") {
      statusText = "Suspended";
      badgeClass = "badge-hold";
    }
    
    const isSelf = currentUser && currentUser.email.toLowerCase() === user.email.toLowerCase();
    const isVerified = user.emailVerified ? "Yes" : "No";
    const verifiedBadge = user.emailVerified ? "badge-completed" : "badge-pending";
    const name = user.name || "Pending Name";
    
    // Dropdown selects for Role
    const roles = [
      { val: "pending", label: "Pending" },
      { val: "operator", label: "Operator" },
      { val: "production_admin", label: "Production Admin" },
      { val: "hr_admin", label: "HR Admin" },
      { val: "quality_admin", label: "Quality Admin" },
      { val: "it_team", label: "IT Team" },
      { val: "super_admin", label: "Super Admin" }
    ];
    let roleSelectHtml = `<select id="user-role-select-${user.uid}" class="form-input select-sm" ${isSelf ? 'disabled' : ''} style="height:32px; padding:2px 5px; font-size:12px; min-width:130px;">`;
    roles.forEach(r => {
      roleSelectHtml += `<option value="${r.val}" ${user.role === r.val ? 'selected' : ''}>${r.label}</option>`;
    });
    roleSelectHtml += `</select>`;

    // Dropdown selects for Department
    const depts = [
      { val: "pending", label: "Pending" },
      { val: "Masking", label: "Masking" },
      { val: "Spraying", label: "Spraying" },
      { val: "Grinding", label: "Grinding" },
      { val: "Polishing", label: "Polishing" },
      { val: "Inspection", label: "Inspection" },
      { val: "All", label: "All Departments" }
    ];
    let deptSelectHtml = `<select id="user-dept-select-${user.uid}" class="form-input select-sm" ${isSelf ? 'disabled' : ''} style="height:32px; padding:2px 5px; font-size:12px; min-width:120px;">`;
    depts.forEach(d => {
      deptSelectHtml += `<option value="${d.val}" ${user.department === d.val ? 'selected' : ''}>${d.label}</option>`;
    });
    deptSelectHtml += `</select>`;

    tr.innerHTML = `
      <td>
        <div style="font-weight:bold;">${name}</div>
        <div class="text-xs text-muted" style="font-size:11px; margin-top:2px;">${user.email}</div>
      </td>
      <td><span class="badge ${verifiedBadge}">${isVerified}</span></td>
      <td>${roleSelectHtml}</td>
      <td>${deptSelectHtml}</td>
      <td><span class="badge ${badgeClass}">${statusText}</span></td>
      <td>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-success btn-xs" onclick="saveAndApproveUser('${user.uid}')" ${isSelf ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
            Save & Approve
          </button>
          <button class="btn btn-warning btn-xs" onclick="toggleUserStatus('${user.uid}')" ${isSelf ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
            ${user.active ? 'Disable' : 'Enable'}
          </button>
          <button class="btn btn-danger btn-xs" onclick="deleteUser('${user.uid}')" ${isSelf ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
            Delete
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function saveAndApproveUser(uid) {
  const roleSelect = document.getElementById(`user-role-select-${uid}`);
  const deptSelect = document.getElementById(`user-dept-select-${uid}`);
  if (!roleSelect || !deptSelect) return;

  const role = roleSelect.value;
  const department = deptSelect.value;

  const isMock = !firebaseConfig.apiKey || firebaseConfig.apiKey.includes("YOUR_FIREBASE_") || localStorage.getItem("psp_auth_mock") === "true";
  let users = [];
  
  if (!isMock) {
    try {
      const db = firebase.firestore();
      const snapshot = await db.collection("users").get();
      snapshot.forEach(doc => users.push(doc.data()));
    } catch (e) {
      users = MOCK_DB.getUsers();
    }
  } else {
    users = MOCK_DB.getUsers();
  }

  const user = users.find(u => u.uid === uid);
  if (!user) {
    alert("User not found.");
    return;
  }

  // Check super admin singleton constraint
  if (role === 'super_admin') {
    const hasSuper = users.some(u => u.role === 'super_admin' && u.uid !== uid);
    if (hasSuper) {
      alert("Super Admin account already exists.");
      return;
    }
  }

  // Update locally in MOCK_DB
  const mockUsers = MOCK_DB.getUsers();
  const mockUser = mockUsers.find(u => u.uid === uid);
  if (mockUser) {
    mockUser.role = role;
    mockUser.department = department;
    mockUser.active = true;
    mockUser.emailVerified = true; // Auto-verify email upon manual approval by admin
    MOCK_DB.saveUsers(mockUsers);
  }

  if (!isMock) {
    try {
      const db = firebase.firestore();
      await db.collection("users").doc(uid).update({
        role: role,
        department: department,
        active: true,
        emailVerified: true
      });
      alert(`User profile for ${user.email} approved and updated successfully in Firestore.`);
    } catch (err) {
      console.error("Firestore user approval sync error:", err);
      alert("Approved locally, but Firestore sync failed: " + err.message);
    }
  } else {
    alert(`User profile for ${user.email} approved and updated successfully (Mock Mode).`);
  }

  // Audit log
  createAuditLog(currentUser.email, null, `Approved & assigned role ${role.toUpperCase()} and department ${department} to user ${user.email}`);

  renderAll();
}

async function toggleUserStatus(uid) {
  const users = MOCK_DB.getUsers();
  const user = users.find(u => u.uid === uid);
  if (user) {
    user.active = !user.active;
    MOCK_DB.saveUsers(users);
    
    // Audit log
    createAuditLog(currentUser.email, null, `Changed status of user '${user.email}' to ${user.active ? 'Enabled' : 'Disabled'}`);
    
    // If we are in live firebase mode, sync user status
    const isMock = !firebaseConfig.apiKey || firebaseConfig.apiKey.includes("YOUR_FIREBASE_") || localStorage.getItem("psp_auth_mock") === "true";
    if (!isMock) {
      try {
        const db = firebase.firestore();
        await db.collection("users").doc(uid).update({ active: user.active });
      } catch (err) {
        console.error("Firestore user status sync error:", err);
      }
    }
    
    renderAll();
  }
}

async function deleteUser(uid) {
  const users = MOCK_DB.getUsers();
  const userIdx = users.findIndex(u => u.uid === uid);
  if (userIdx !== -1) {
    const user = users[userIdx];
    if (confirm(`Are you sure you want to delete access profile for: ${user.email}?`)) {
      users.splice(userIdx, 1);
      MOCK_DB.saveUsers(users);
      
      // Remove password entry
      const passwords = MOCK_DB.getPasswords();
      delete passwords[user.email];
      localStorage.setItem('mock_db_passwords', JSON.stringify(passwords));
      
      createAuditLog(currentUser.email, null, `Deleted access profile for user: ${user.email}`);
      
      // If live firebase, delete Firestore doc
      const isMock = !firebaseConfig.apiKey || firebaseConfig.apiKey.includes("YOUR_FIREBASE_") || localStorage.getItem("psp_auth_mock") === "true";
      if (!isMock) {
        try {
          const db = firebase.firestore();
          await db.collection("users").doc(uid).delete();
        } catch (err) {
          console.error("Firestore user deletion sync error:", err);
        }
      }
      
      renderAll();
    }
  }
}

// Expose stage functions to global window scope so onclick bindings can reach them
window.progressGrindingJob = progressGrindingJob;
window.progressPolishingJob = progressPolishingJob;
window.progressFinalInspectionJob = progressFinalInspectionJob;
window.progressDispatchJob = progressDispatchJob;
window.toggleUserStatus = toggleUserStatus;
window.deleteUser = deleteUser;
window.saveAndApproveUser = saveAndApproveUser;

// 13. DOM EVENTS HOOKS & ATTACHMENTS
function setupEventListeners() {
  // Modal Close triggers
  const modal = document.getElementById("modal-assign-operator");
  modal.querySelector(".modal-close").addEventListener("click", closeAssignModal);
  modal.querySelector(".modal-cancel-btn").addEventListener("click", closeAssignModal);

  // Operator modal submit form
  document.getElementById("operator-assign-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const kp = document.getElementById("modal-kp-display").textContent;
    if (!selectedOperatorName) {
      alert("Please select an operator first.");
      return;
    }
    startMaskingCycle(kp, selectedOperatorName, selectedShiftName);
  });

  // Action Panel buttons
  document.getElementById("btn-start-cycle").addEventListener("click", () => {
    if (selectedJobKp) openAssignModal(selectedJobKp);
  });
  document.getElementById("btn-pause-cycle").addEventListener("click", pauseMaskingCycle);
  document.getElementById("btn-resume-cycle").addEventListener("click", resumeMaskingCycle);
  document.getElementById("btn-end-cycle").addEventListener("click", endMaskingCycle);

  // Complete Masking modal triggers
  document.getElementById("btn-close-complete-masking").addEventListener("click", closeCompleteMaskingModal);
  document.getElementById("btn-cancel-complete-masking").addEventListener("click", closeCompleteMaskingModal);
  document.getElementById("masking-complete-form").addEventListener("submit", submitCompleteMasking);

  // Material forms
  document.getElementById("btn-add-mat-to-job").addEventListener("click", addMaterialToJob);

  // Hold management submits (safe checks as Module 9 is removed)
  const btnSubmitHold = document.getElementById("btn-submit-hold");
  if (btnSubmitHold) btnSubmitHold.addEventListener("click", submitHoldJob);
  const btnSubmitResume = document.getElementById("btn-submit-resume");
  if (btnSubmitResume) btnSubmitResume.addEventListener("click", submitResumeJob);

  // Pause Modal listeners
  const closePauseBtn = document.getElementById("btn-close-pause-masking");
  if (closePauseBtn) closePauseBtn.addEventListener("click", closePauseMaskingModal);
  const cancelPauseBtn = document.getElementById("btn-cancel-pause-masking");
  if (cancelPauseBtn) cancelPauseBtn.addEventListener("click", closePauseMaskingModal);
  const pauseForm = document.getElementById("masking-pause-form");
  if (pauseForm) pauseForm.addEventListener("submit", submitPauseMasking);

  // Filters Queue listeners
  document.getElementById("filter-kp").addEventListener("input", renderLiveJobQueue);
  document.getElementById("filter-customer").addEventListener("input", renderLiveJobQueue);
  document.getElementById("filter-process").addEventListener("change", renderLiveJobQueue);
  document.getElementById("filter-status").addEventListener("change", renderLiveJobQueue);
  document.getElementById("btn-clear-filters").addEventListener("click", () => {
    document.getElementById("filter-kp").value = "";
    document.getElementById("filter-customer").value = "";
    document.getElementById("filter-process").value = "";
    document.getElementById("filter-status").value = "";
    renderLiveJobQueue();
  });

  // Filters History listeners
  document.getElementById("hist-filter-kp").addEventListener("input", renderJobHistory);
  document.getElementById("hist-filter-customer").addEventListener("input", renderJobHistory);
  document.getElementById("hist-filter-operator").addEventListener("input", renderJobHistory);
  document.getElementById("hist-filter-process").addEventListener("change", renderJobHistory);
  document.getElementById("btn-clear-hist-filters").addEventListener("click", () => {
    document.getElementById("hist-filter-kp").value = "";
    document.getElementById("hist-filter-customer").value = "";
    document.getElementById("hist-filter-operator").value = "";
    document.getElementById("hist-filter-process").value = "";
    renderJobHistory();
  });

  // Dynamic Inspection Google Sheet Listeners
  document.getElementById("inspect-kp-no").addEventListener("change", () => {
    updateInspectionDropdowns();
  });
  document.getElementById("inspect-part-name").addEventListener("change", () => {
    updateInspectionDropdowns();
  });
  document.getElementById("inspect-customer").addEventListener("change", () => {
    updateInspectionDropdowns();
  });
  document.getElementById("inspect-quantity").addEventListener("change", () => {
    updateInspectionDropdowns();
  });

  const btnRefreshInspection = document.getElementById("btn-refresh-inspection");
  if (btnRefreshInspection) {
    btnRefreshInspection.addEventListener("click", async () => {
      const originalText = btnRefreshInspection.innerHTML;
      btnRefreshInspection.disabled = true;
      btnRefreshInspection.innerHTML = '<span>🔄</span> LOADING...';
      try {
        await loadInspectionKPs(true);
      } finally {
        btnRefreshInspection.disabled = false;
        btnRefreshInspection.innerHTML = originalText;
      }
    });
  }

  // Admin Inspection Workload Tracking Filters
  const filterOpEl = document.getElementById("admin-filter-operator");
  const filterStatEl = document.getElementById("admin-filter-status");
  if (filterOpEl) {
    filterOpEl.addEventListener("change", renderAdminInspectionTracking);
  }
  if (filterStatEl) {
    filterStatEl.addEventListener("change", renderAdminInspectionTracking);
  }

  // Simulation Inspection Job Registry form
  document.getElementById("inspection-job-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const kpNo = document.getElementById("inspect-kp-no").value.trim();
    const partName = document.getElementById("inspect-part-name").value.trim();
    const cust = document.getElementById("inspect-customer").value.trim();
    const qty = parseInt(document.getElementById("inspect-quantity").value);
    const proc = document.getElementById("inspect-process-type").value;
    const prio = document.getElementById("inspect-priority").value;

    // Check validation against activeInspectionRecord to prevent forged combinations
    if (!activeInspectionRecord || 
        activeInspectionRecord.kpNo !== kpNo || 
        activeInspectionRecord.partName !== partName || 
        activeInspectionRecord.customer !== cust || 
        parseInt(activeInspectionRecord.quantity) !== qty) {
      alert("Validation Error: Invalid record data combination. Please re-select the KP Number.");
      return;
    }

    // Check duplicate
    const exists = jobs.some(j => j.kpNumber.toLowerCase() === kpNo.toLowerCase());
    if (exists) {
      alert("A job with this KP Number already exists in the system.");
      return;
    }

    const payload = {
      type: "CREATE_JOB",
      kpNo: kpNo,
      partName: partName,
      customer: cust,
      quantity: qty,
      processType: proc,
      priority: prio,
      inspectionDate: new Date().toISOString().split('T')[0]
    };

    // Optimistic UI mutation
    const newJob = {
      kpNumber: kpNo,
      partName: partName,
      customer: cust,
      quantity: qty,
      processType: proc,
      priority: prio,
      inspectionDate: new Date().toISOString().split('T')[0],
      receivedDate: new Date().toISOString().split('T')[0],
      currentDepartment: "Inspection",
      status: "Pending",
      masking: { status: "Pending", materials: [], holdHistory: [] },
      spraying: { status: "Pending" },
      grinding: { status: "Pending" },
      polishing: { status: "Pending" },
      finalInspection: { status: "Pending" },
      dispatch: { status: "Pending" }
    };
    jobs.push(newJob);

    // Reset Form & render instantly
    document.getElementById("inspection-job-form").reset();
    document.getElementById("inspect-customer").value = "";
    document.getElementById("inspect-part-name").value = "";
    document.getElementById("inspect-quantity").value = "";
    activeInspectionRecord = null;
    renderAll();

    // Background sync
    pendingSyncCount++;
    sendBackendPost(payload)
      .then(() => {
        pendingSyncCount--;
        if (pendingSyncCount === 0) {
          return loadState().then(() => renderAll());
        }
      })
      .catch(err => {
        pendingSyncCount--;
        console.error("Failed to sync job creation:", err);
        if (pendingSyncCount === 0) {
          // Rollback if failed
          jobs = jobs.filter(j => j.kpNumber !== kpNo);
          renderAll();
        }
      });
  });


  // System Controls
  document.getElementById("btn-reset-data").addEventListener("click", resetData);
  document.getElementById("btn-theme-toggle").addEventListener("click", toggleTheme);
  document.getElementById("btn-export-logs").addEventListener("click", () => {
    console.log("MES SHOP FLOOR AUDIT LOG:");
    console.table(auditLogs);
    alert("Audit log exported to Browser Developer Console (Ctrl+Shift+I or F12).");
  });

  // Logout event
  const logoutBtn = document.getElementById("btn-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      createAuditLog(currentUser.email, null, "Logout Success");
      localStorage.removeItem("psp_logged_in_user");
      window.location.href = "login.html";
    });
  }

  // Access Denied Modal Close
  const closeAccessDeniedBtn = document.getElementById("btn-close-access-denied");
  if (closeAccessDeniedBtn) {
    closeAccessDeniedBtn.addEventListener("click", () => {
      document.getElementById("access-denied-modal").classList.remove("active");
    });
  }

  // User Management Role select filter
  const userRoleSelect = document.getElementById("user-role");
  if (userRoleSelect) {
    userRoleSelect.addEventListener("change", (e) => {
      const role = e.target.value;
      const deptSelect = document.getElementById("user-dept");
      if (deptSelect) {
        deptSelect.innerHTML = "";
        if (role === 'operator') {
          deptSelect.innerHTML = `
            <option value="Masking">Masking Operator</option>
            <option value="Spraying">Spraying Operator</option>
            <option value="Grinding">Grinding Operator</option>
            <option value="Polishing">Polishing Operator</option>
          `;
        } else {
          deptSelect.innerHTML = `
            <option value="All">All Departments (Admins / HR / Quality)</option>
            <option value="Production">Production</option>
            <option value="HR">HR</option>
            <option value="Quality">Quality</option>
          `;
        }
      }
    });
  }

  // User creation form submit
  const userForm = document.getElementById("user-creation-form");
  if (userForm) {
    userForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("user-email").value.trim();
      const password = document.getElementById("user-password").value;
      const confirmPass = document.getElementById("user-confirm-password").value;
      const role = document.getElementById("user-role").value;
      const department = document.getElementById("user-dept").value;
      
      if (password !== confirmPass) {
        alert("Passwords do not match.");
        return;
      }
      if (password.length < 6) {
        alert("Password must be at least 6 characters.");
        return;
      }
      
      // === COMPANY EMAIL DOMAIN RESTRICTION ===
      var ALLOWED_DOMAIN = '@plasmaspray.co.in';
      if (!email.toLowerCase().endsWith(ALLOWED_DOMAIN)) {
        alert("Access Denied. Only @plasmaspray.co.in email addresses are allowed.");
        return;
      }
      
      const users = MOCK_DB.getUsers();
      
      // Singleton super admin check
      if (role === 'super_admin') {
        const hasSuper = users.some(u => u.role === 'super_admin');
        if (hasSuper) {
          alert("Super Admin account already exists.");
          return;
        }
      }
      
      if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
        alert("A user with this email is already registered.");
        return;
      }
      
      const newUid = `uid-${Math.floor(100000 + Math.random() * 900000)}`;
      const newUser = {
        uid: newUid,
        email,
        role,
        department: role === 'super_admin' ? 'All' : department,
        active: true
      };
      
      MOCK_DB.addUser(newUser, password);
      
      const isMock = !firebaseConfig.apiKey || firebaseConfig.apiKey.includes("YOUR_FIREBASE_") || localStorage.getItem("psp_auth_mock") === "true";
      if (!isMock) {
        try {
          const db = firebase.firestore();
          await db.collection("users").doc(newUid).set({
            uid: newUid,
            email,
            role,
            department: newUser.department,
            active: true,
            createdAt: new Date().toISOString()
          });
        } catch (err) {
          console.error("Firestore user creation sync error:", err);
        }
      }
      
      createAuditLog(currentUser.email, null, `Created access profile for user: ${email} (${role.toUpperCase()})`);
      userForm.reset();
      renderAll();
      alert("User profile provisioned successfully.");
    });
  }

  // === GRINDING EVENT LISTENERS ===
  // Grinding Queue Filters
  const grindFilterKp = document.getElementById("grinding-filter-kp");
  if (grindFilterKp) grindFilterKp.addEventListener("input", renderGrindingLiveQueue);
  
  const grindFilterCust = document.getElementById("grinding-filter-customer");
  if (grindFilterCust) grindFilterCust.addEventListener("input", renderGrindingLiveQueue);
  
  const grindFilterMach = document.getElementById("grinding-filter-machine");
  if (grindFilterMach) grindFilterMach.addEventListener("change", renderGrindingLiveQueue);
  
  const grindFilterProc = document.getElementById("grinding-filter-process");
  if (grindFilterProc) grindFilterProc.addEventListener("change", renderGrindingLiveQueue);
  
  const grindClearFilters = document.getElementById("btn-grinding-clear-filters");
  if (grindClearFilters) {
    grindClearFilters.addEventListener("click", () => {
      document.getElementById("grinding-filter-kp").value = "";
      document.getElementById("grinding-filter-customer").value = "";
      document.getElementById("grinding-filter-machine").value = "";
      document.getElementById("grinding-filter-process").value = "";
      renderGrindingLiveQueue();
    });
  }

  // Grinding History Filters
  const grindHistFilterKp = document.getElementById("grinding-hist-filter-kp");
  if (grindHistFilterKp) grindHistFilterKp.addEventListener("input", renderGrindingHistory);
  
  const grindHistFilterCust = document.getElementById("grinding-hist-filter-customer");
  if (grindHistFilterCust) grindHistFilterCust.addEventListener("input", renderGrindingHistory);
  
  const grindHistFilterMach = document.getElementById("grinding-hist-filter-machine");
  if (grindHistFilterMach) grindHistFilterMach.addEventListener("input", renderGrindingHistory);
  
  const grindHistFilterProc = document.getElementById("grinding-hist-filter-process");
  if (grindHistFilterProc) grindHistFilterProc.addEventListener("change", renderGrindingHistory);
  
  const grindClearHistFilters = document.getElementById("btn-grinding-clear-hist-filters");
  if (grindClearHistFilters) {
    grindClearHistFilters.addEventListener("click", () => {
      document.getElementById("grinding-hist-filter-kp").value = "";
      document.getElementById("grinding-hist-filter-customer").value = "";
      document.getElementById("grinding-hist-filter-machine").value = "";
      document.getElementById("grinding-hist-filter-process").value = "";
      renderGrindingHistory();
    });
  }

  // Grinding Active Station cycle control buttons
  const btnGrindStart = document.getElementById("btn-grinding-start-cycle");
  if (btnGrindStart) {
    btnGrindStart.addEventListener("click", () => {
      if (selectedGrindingJobKp) openStartGrindingModal(selectedGrindingJobKp);
    });
  }

  const btnGrindPause = document.getElementById("btn-grinding-pause-cycle");
  if (btnGrindPause) btnGrindPause.addEventListener("click", pauseGrindingCycle);
  
  const btnGrindResume = document.getElementById("btn-grinding-resume-cycle");
  if (btnGrindResume) btnGrindResume.addEventListener("click", resumeGrindingCycle);
  
  const btnGrindEnd = document.getElementById("btn-grinding-end-cycle");
  if (btnGrindEnd) btnGrindEnd.addEventListener("click", endGrindingCycle);

  // Grinding Modals forms
  const grindStartForm = document.getElementById("grinding-start-form");
  if (grindStartForm) grindStartForm.addEventListener("submit", submitStartGrinding);
  
  const grindPauseForm = document.getElementById("grinding-pause-form");
  if (grindPauseForm) grindPauseForm.addEventListener("submit", submitPauseGrinding);
  
  const grindCompleteForm = document.getElementById("grinding-complete-form");
  if (grindCompleteForm) grindCompleteForm.addEventListener("submit", submitCompleteGrinding);

  // Grinding Modals Cancel & Close
  const closeStartGrind = document.getElementById("btn-close-start-grinding");
  if (closeStartGrind) closeStartGrind.addEventListener("click", closeGrindingStartModal);
  const cancelStartGrind = document.getElementById("btn-cancel-start-grinding");
  if (cancelStartGrind) cancelStartGrind.addEventListener("click", closeGrindingStartModal);

  const closePauseGrind = document.getElementById("btn-close-pause-grinding");
  if (closePauseGrind) closePauseGrind.addEventListener("click", closeGrindingPauseModal);
  const cancelPauseGrind = document.getElementById("btn-cancel-pause-grinding");
  if (cancelPauseGrind) cancelPauseGrind.addEventListener("click", closeGrindingPauseModal);

  const closeCompleteGrind = document.getElementById("btn-close-complete-grinding");
  if (closeCompleteGrind) closeCompleteGrind.addEventListener("click", closeGrindingCompleteModal);
  const cancelCompleteGrind = document.getElementById("btn-cancel-complete-grinding");
  if (cancelCompleteGrind) cancelCompleteGrind.addEventListener("click", closeGrindingCompleteModal);
}

// =========================================================================
// IT DATA MANAGEMENT DASHBOARD (DMD) - CONTROLLERS & RENDERING
// =========================================================================

let dmdSelectedEntity = null;
let dmdSelectedAction = null;

function setupDmdEventListeners() {
  const dmdSubtabButtons = document.querySelectorAll(".dmd-subtab-btn");
  dmdSubtabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      dmdSubtabButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      const targetSubtab = btn.getAttribute("data-subtab");
      activeDmdDSubtab = targetSubtab; // save state
      
      const contents = document.querySelectorAll(".dmd-subtab-content");
      contents.forEach(c => {
        if (c.id === targetSubtab) {
          c.classList.remove("hidden");
        } else {
          c.classList.add("hidden");
        }
      });
    });
  });

  const crudForm = document.getElementById("dmd-crud-form");
  if (crudForm) {
    crudForm.addEventListener("submit", submitCrudForm);
  }
}

function renderDmdDashboard() {
  const dmdPane = document.getElementById("tab-data-management");
  if (!dmdPane || !dmdPane.classList.contains("active")) return;

  // 1. Telemetry metrics
  const activeSessions = users.filter(u => u.active).length;
  document.getElementById("dmd-telemetry-jobs-count").textContent = jobs.length;
  document.getElementById("dmd-telemetry-users-count").textContent = users.length;
  document.getElementById("dmd-telemetry-audit-count").textContent = auditLogs.length;
  document.getElementById("dmd-telemetry-active-sessions").textContent = activeSessions;

  // 2. Health & Latency
  const firestoreStatusEl = document.getElementById("dmd-health-firestore-status");
  if (firestoreStatusEl) {
    if (isMockMode()) {
      firestoreStatusEl.textContent = "MOCK MODE";
      firestoreStatusEl.className = "badge badge-hold";
    } else {
      firestoreStatusEl.textContent = "CONNECTED";
      firestoreStatusEl.className = "badge badge-completed";
    }
  }
  document.getElementById("dmd-health-heartbeat").textContent = new Date().toLocaleTimeString();

  // 3. Error Console
  const errorTbody = document.getElementById("dmd-error-console-body");
  if (errorTbody) {
    errorTbody.innerHTML = "";
    const errors = window.errorLogsData || [];
    if (errors.length === 0) {
      errorTbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No system errors logged.</td></tr>`;
    } else {
      errors.forEach(e => {
        const tr = document.createElement("tr");
        const ts = e.timestamp?.toDate ? e.timestamp.toDate().toLocaleString() : (e.timestamp || "N/A");
        tr.innerHTML = `
          <td class="font-mono" style="font-size:11px;">${ts}</td>
          <td class="font-mono" style="font-size:11px;">${e.userId || 'N/A'}</td>
          <td><strong>${e.path || 'N/A'}</strong></td>
          <td class="text-danger" style="font-size:12px;">${e.errorMessage || ''}</td>
        `;
        errorTbody.appendChild(tr);
      });
    }
  }

  // 4. Live Job Monitoring
  const jobsTbody = document.getElementById("dmd-live-jobs-body");
  if (jobsTbody) {
    jobsTbody.innerHTML = "";
    if (jobs.length === 0) {
      jobsTbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No jobs in factory.</td></tr>`;
    } else {
      jobs.forEach(j => {
        const tr = document.createElement("tr");
        let badgeClass = "badge-pending";
        if (j.status === "In Progress") badgeClass = "badge-completed";
        else if (j.status === "Hold") badgeClass = "badge-hold";
        
        tr.innerHTML = `
          <td class="font-mono"><strong>${j.kpNumber}</strong></td>
          <td>
            <div>${j.partName}</div>
            <div class="text-xs text-muted" style="font-size:11px;">${j.customer} (Qty: ${j.quantity})</div>
          </td>
          <td><span class="badge" style="background:rgba(255,255,255,0.05);">${j.currentDepartment}</span></td>
          <td><span class="badge ${badgeClass}">${j.status}</span></td>
          <td>${j.operatorName || 'None'}</td>
          <td class="font-mono">${j.storeLocation || 'N/A'}</td>
        `;
        jobsTbody.appendChild(tr);
      });
    }
  }

  // 5. Live Stage Monitoring
  const stageContainer = document.getElementById("dmd-stage-monitoring-container");
  if (stageContainer) {
    stageContainer.innerHTML = "";
    const stagesList = ["Inspection", "Masking", "Spraying", "Grinding", "Polishing", "Final Inspection", "Dispatch"];
    stagesList.forEach(s => {
      const count = jobs.filter(j => j.currentDepartment === s).length;
      const running = jobs.filter(j => j.currentDepartment === s && j.status === "In Progress").length;
      
      const div = document.createElement("div");
      div.className = "kpi-card";
      div.style.padding = "10px 15px";
      div.style.borderLeftColor = count > 0 ? "var(--accent-color)" : "var(--border-color)";
      div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>${s} Stage</strong>
          <span class="badge" style="background:rgba(255,255,255,0.05); font-size:14px; font-weight:bold;">${count} Total</span>
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
          Running: ${running} | Idle/Pending: ${count - running}
        </div>
      `;
      stageContainer.appendChild(div);
    });
  }

  // 6. Live Machine Monitoring
  const machinesTbody = document.getElementById("dmd-live-machines-body");
  if (machinesTbody) {
    machinesTbody.innerHTML = "";
    if (machines.length === 0) {
      machinesTbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No machines registered.</td></tr>`;
    } else {
      machines.forEach(m => {
        const tr = document.createElement("tr");
        let badgeClass = "badge-pending";
        if (m.status === "running") badgeClass = "badge-completed";
        else if (m.status === "maintenance") badgeClass = "badge-hold";
        
        tr.innerHTML = `
          <td><strong>${m.name || m.machineId}</strong></td>
          <td><span class="badge ${badgeClass}">${m.status}</span></td>
          <td>${m.currentOperator?.email || 'None'}</td>
          <td class="font-mono">${m.currentJobId || 'None'}</td>
        `;
        machinesTbody.appendChild(tr);
      });
    }
  }

  // 7. Material Consumption Ledger
  const ledgerTbody = document.getElementById("dmd-material-ledger-body");
  if (ledgerTbody) {
    ledgerTbody.innerHTML = "";
    let ledger = [];
    jobs.forEach(j => {
      if (j.masking && j.masking.materials) {
        j.masking.materials.forEach(m => {
          if (m.actualQty > 0) {
            ledger.push({
              timestamp: j.masking.endTime || new Date().toISOString(),
              kpNo: j.kpNumber,
              stage: "Masking",
              name: m.name,
              planned: m.plannedQty,
              actual: m.actualQty,
              unit: m.unit,
              operator: j.masking.operatorName || "Operator"
            });
          }
        });
      }
      if (j.spraying && j.spraying.status === "Completed") {
        ledger.push({
          timestamp: j.spraying.endTime || new Date().toISOString(),
          kpNo: j.kpNumber,
          stage: "Spraying",
          name: "Powder Consumed",
          planned: 0,
          actual: j.spraying.powderConsumed || 0,
          unit: "KG",
          operator: "Spraying Operator"
        });
      }
    });
    
    if (ledger.length === 0) {
      ledgerTbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">No material consumption logged yet.</td></tr>`;
    } else {
      ledger.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
      ledger.forEach(item => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="font-mono" style="font-size:11px;">${new Date(item.timestamp).toLocaleString()}</td>
          <td class="font-mono"><strong>${item.kpNo}</strong></td>
          <td>${item.stage}</td>
          <td>${item.name}</td>
          <td class="font-mono">${item.planned}</td>
          <td class="font-mono text-cyan">${item.actual}</td>
          <td>${item.unit}</td>
          <td>${item.operator}</td>
        `;
        ledgerTbody.appendChild(tr);
      });
    }
  }

  // 8. Live Operator Monitoring
  const opsTbody = document.getElementById("dmd-live-operators-body");
  if (opsTbody) {
    opsTbody.innerHTML = "";
    const ops = users.filter(u => u.role === 'operator' || u.role === 'pending');
    if (ops.length === 0) {
      opsTbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No operators active.</td></tr>`;
    } else {
      ops.forEach(o => {
        const tr = document.createElement("tr");
        let badgeClass = o.active ? "badge-completed" : "badge-pending";
        tr.innerHTML = `
          <td><strong>${o.name || o.email}</strong></td>
          <td class="font-mono">${o.shift || 'N/A'}</td>
          <td>${o.department || 'pending'}</td>
          <td><span class="badge ${badgeClass}">${o.active ? 'Active' : 'Pending'}</span></td>
        `;
        opsTbody.appendChild(tr);
      });
    }
  }

  // 9. Real-Time Audit Log Feed
  const auditTbody = document.getElementById("dmd-live-audit-body");
  if (auditTbody) {
    auditTbody.innerHTML = "";
    if (auditLogs.length === 0) {
      auditTbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No audit events recorded.</td></tr>`;
    } else {
      auditLogs.slice(0, 15).forEach(log => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="font-mono" style="font-size:11px;">${new Date(log.timestamp).toLocaleTimeString()}</td>
          <td><strong>${log.user}</strong> <span class="text-muted">(${log.role})</span></td>
          <td><span class="badge" style="background:rgba(255,255,255,0.05);">${log.department}</span></td>
          <td style="font-size:12px;">${log.action}</td>
        `;
        auditTbody.appendChild(tr);
      });
    }
  }

  // 10. IT User Authorization elevation
  const userTbody = document.getElementById("dmd-user-table-body");
  if (userTbody) {
    userTbody.innerHTML = "";
    if (users.length === 0) {
      userTbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No users in database.</td></tr>`;
    } else {
      users.forEach(user => {
        const tr = document.createElement("tr");
        let statusText = user.active ? "Active" : "Pending";
        let badgeClass = user.active ? "badge-completed" : "badge-pending";
        const isSelf = currentUser && currentUser.email.toLowerCase() === user.email.toLowerCase();
        
        const roles = [
          { val: "pending", label: "Pending" },
          { val: "operator", label: "Operator" },
          { val: "production_admin", label: "Production Admin" },
          { val: "hr_admin", label: "HR Admin" },
          { val: "quality_admin", label: "Quality Admin" },
          { val: "it_team", label: "IT Team" },
          { val: "super_admin", label: "Super Admin" }
        ];
        let roleSelectHtml = `<select id="dmd-user-role-select-${user.uid}" class="form-input select-sm" ${isSelf ? 'disabled' : ''} style="height:32px; padding:2px 5px; font-size:12px;">`;
        roles.forEach(r => {
          roleSelectHtml += `<option value="${r.val}" ${user.role === r.val ? 'selected' : ''}>${r.label}</option>`;
        });
        roleSelectHtml += `</select>`;

        const depts = [
          { val: "pending", label: "Pending" },
          { val: "Masking", label: "Masking" },
          { val: "Spraying", label: "Spraying" },
          { val: "Grinding", label: "Grinding" },
          { val: "Polishing", label: "Polishing" },
          { val: "Inspection", label: "Inspection" },
          { val: "All", label: "All Departments" }
        ];
        let deptSelectHtml = `<select id="dmd-user-dept-select-${user.uid}" class="form-input select-sm" ${isSelf ? 'disabled' : ''} style="height:32px; padding:2px 5px; font-size:12px;">`;
        depts.forEach(d => {
          deptSelectHtml += `<option value="${d.val}" ${user.department === d.val ? 'selected' : ''}>${d.label}</option>`;
        });
        deptSelectHtml += `</select>`;

        tr.innerHTML = `
          <td>
            <div style="font-weight:bold;">${user.name || 'No Name'}</div>
            <div class="text-xs text-muted" style="font-size:11px;">${user.email}</div>
          </td>
          <td><span class="badge ${user.emailVerified ? 'badge-completed' : 'badge-pending'}">${user.emailVerified ? 'Yes' : 'No'}</span></td>
          <td>${roleSelectHtml}</td>
          <td>${deptSelectHtml}</td>
          <td><span class="badge ${badgeClass}">${statusText}</span></td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-success btn-xs" onclick="saveAndApproveUserDmd('${user.uid}')" ${isSelf ? 'disabled style="opacity:0.5"' : ''}>Save</button>
              <button class="btn btn-warning btn-xs" onclick="toggleUserStatusDmd('${user.uid}')" ${isSelf ? 'disabled style="opacity:0.5"' : ''}>Status</button>
            </div>
          </td>
        `;
        userTbody.appendChild(tr);
      });
    }
  }
}

function openCrudModal(entity, action) {
  dmdSelectedEntity = entity;
  dmdSelectedAction = action;

  const modal = document.getElementById("dmd-crud-modal");
  const title = document.getElementById("dmd-crud-modal-title");
  const fieldsDiv = document.getElementById("dmd-crud-form-fields");
  
  if (!modal || !title || !fieldsDiv) return;
  
  title.textContent = `${action.toUpperCase()} ${entity.toUpperCase()}`;
  fieldsDiv.innerHTML = "";
  
  let fieldsHtml = "";
  
  if (entity === 'job') {
    if (action === 'create') {
      fieldsHtml = `
        <div class="form-group"><label>KP Number *</label><input type="text" id="crud-job-kp" class="form-input" required placeholder="e.g. KP-1020"></div>
        <div class="form-group"><label>Part Name *</label><input type="text" id="crud-job-part" class="form-input" required placeholder="e.g. Turbine Impeller"></div>
        <div class="form-group"><label>Customer *</label><input type="text" id="crud-job-customer" class="form-input" required placeholder="e.g. ISRO"></div>
        <div class="form-group"><label>Quantity *</label><input type="number" id="crud-job-qty" class="form-input" required value="1" min="1"></div>
        <div class="form-group"><label>Process Type *</label>
          <select id="crud-job-process" class="form-input">
            <option value="Plasma">Plasma</option>
            <option value="HCOS">HCOS</option>
            <option value="HVOF">HVOF</option>
          </select>
        </div>
        <div class="form-group"><label>Priority *</label>
          <select id="crud-job-priority" class="form-input">
            <option value="Normal">Normal</option>
            <option value="High">High</option>
            <option value="Critical">Critical</option>
          </select>
        </div>
        <div class="form-group"><label>Initial Stage *</label>
          <select id="crud-job-stage" class="form-input">
            <option value="Inspection">Inspection</option>
            <option value="Masking">Masking</option>
            <option value="Spraying">Spraying</option>
            <option value="Grinding">Grinding</option>
            <option value="Polishing">Polishing</option>
          </select>
        </div>
        <div class="form-group"><label>Store Location</label><input type="text" id="crud-job-store" class="form-input" placeholder="e.g. A10"></div>
      `;
    } else if (action === 'edit') {
      let jobOptions = jobs.map(j => `<option value="${j.kpNumber}">${j.kpNumber} (${j.partName})</option>`).join("");
      fieldsHtml = `
        <div class="form-group"><label>Select Job to Edit *</label>
          <select id="crud-job-select" class="form-input" onchange="loadCrudJobDetails(this.value)">
            <option value="">-- Choose Job --</option>
            ${jobOptions}
          </select>
        </div>
        <div id="crud-job-edit-details" class="hidden" style="display: flex; flex-direction: column; gap: 15px;"></div>
      `;
    } else if (action === 'delete') {
      let jobOptions = jobs.map(j => `<option value="${j.kpNumber}">${j.kpNumber} (${j.partName})</option>`).join("");
      fieldsHtml = `
        <div class="form-group"><label>Select Job to Delete *</label>
          <select id="crud-job-select" class="form-input" required>
            <option value="">-- Choose Job --</option>
            ${jobOptions}
          </select>
        </div>
      `;
    }
  }
  
  else if (entity === 'machine') {
    if (action === 'create') {
      fieldsHtml = `
        <div class="form-group"><label>Machine ID *</label><input type="text" id="crud-machine-id" class="form-input" required placeholder="e.g. hmt_g17"></div>
        <div class="form-group"><label>Name *</label><input type="text" id="crud-machine-name" class="form-input" required placeholder="e.g. HMT G17"></div>
        <div class="form-group"><label>Type *</label><input type="text" id="crud-machine-type" class="form-input" required placeholder="e.g. Grinding Machine"></div>
        <div class="form-group"><label>Department Owner *</label><input type="text" id="crud-machine-dept" class="form-input" required placeholder="e.g. Grinding"></div>
        <div class="form-group"><label>Status *</label>
          <select id="crud-machine-status" class="form-input">
            <option value="idle">idle</option>
            <option value="running">running</option>
            <option value="maintenance">maintenance</option>
            <option value="offline">offline</option>
          </select>
        </div>
      `;
    } else if (action === 'edit') {
      let machOptions = machines.map(m => `<option value="${m.machineId}">${m.name}</option>`).join("");
      fieldsHtml = `
        <div class="form-group"><label>Select Machine to Edit *</label>
          <select id="crud-machine-select" class="form-input" onchange="loadCrudMachineDetails(this.value)">
            <option value="">-- Choose Machine --</option>
            ${machOptions}
          </select>
        </div>
        <div id="crud-machine-edit-details" class="hidden" style="display: flex; flex-direction: column; gap: 15px;"></div>
      `;
    } else if (action === 'delete') {
      let machOptions = machines.map(m => `<option value="${m.machineId}">${m.name}</option>`).join("");
      fieldsHtml = `
        <div class="form-group"><label>Select Machine to Delete *</label>
          <select id="crud-machine-select" class="form-input" required>
            <option value="">-- Choose Machine --</option>
            ${machOptions}
          </select>
        </div>
      `;
    }
  }
  
  else if (entity === 'material') {
    if (action === 'create') {
      fieldsHtml = `
        <div class="form-group"><label>Material ID *</label><input type="text" id="crud-material-id" class="form-input" required placeholder="e.g. silicone_plugs"></div>
        <div class="form-group"><label>Name *</label><input type="text" id="crud-material-name" class="form-input" required placeholder="e.g. Silicone Plugs"></div>
        <div class="form-group"><label>Category *</label><input type="text" id="crud-material-category" class="form-input" required placeholder="e.g. Masking Aid"></div>
        <div class="form-group"><label>Unit of Measure *</label>
          <select id="crud-material-unit" class="form-input">
            <option value="KG">KG</option>
            <option value="Gram">Gram</option>
            <option value="Ltr">Ltr</option>
            <option value="Nos">Nos</option>
          </select>
        </div>
        <div class="form-group"><label>Department *</label><input type="text" id="crud-material-dept" class="form-input" required value="Masking"></div>
      `;
    } else if (action === 'edit') {
      let matOptions = materials.map(m => `<option value="${m.materialId}">${m.name}</option>`).join("");
      fieldsHtml = `
        <div class="form-group"><label>Select Material to Edit *</label>
          <select id="crud-material-select" class="form-input" onchange="loadCrudMaterialDetails(this.value)">
            <option value="">-- Choose Material --</option>
            ${matOptions}
          </select>
        </div>
        <div id="crud-material-edit-details" class="hidden" style="display: flex; flex-direction: column; gap: 15px;"></div>
      `;
    } else if (action === 'delete') {
      let matOptions = materials.map(m => `<option value="${m.materialId}">${m.name}</option>`).join("");
      fieldsHtml = `
        <div class="form-group"><label>Select Material to Delete *</label>
          <select id="crud-material-select" class="form-input" required>
            <option value="">-- Choose Material --</option>
            ${matOptions}
          </select>
        </div>
      `;
    }
  }
  
  else if (entity === 'department') {
    if (action === 'create') {
      fieldsHtml = `
        <div class="form-group"><label>Department Name *</label><input type="text" id="crud-dept-name" class="form-input" required placeholder="e.g. Masking"></div>
        <div class="form-group"><label>Sequence (1-10) *</label><input type="number" id="crud-dept-seq" class="form-input" required value="1" min="1" max="10"></div>
        <div class="form-group"><label>Allowed Store Locations (comma-separated)</label><input type="text" id="crud-dept-locations" class="form-input" placeholder="e.g. M1, M2, M3"></div>
        <div class="form-group"><label>Allowed Pause Reasons (comma-separated)</label><input type="text" id="crud-dept-reasons" class="form-input" placeholder="e.g. Machine Issue, Other"></div>
      `;
    } else if (action === 'edit') {
      let deptsList = window.departmentsList || [];
      let deptOptions = deptsList.map(d => `<option value="${d.name}">${d.name}</option>`).join("");
      fieldsHtml = `
        <div class="form-group"><label>Select Department to Edit *</label>
          <select id="crud-dept-select" class="form-input" onchange="loadCrudDeptDetails(this.value)">
            <option value="">-- Choose Department --</option>
            ${deptOptions}
          </select>
        </div>
        <div id="crud-dept-edit-details" class="hidden" style="display: flex; flex-direction: column; gap: 15px;"></div>
      `;
    } else if (action === 'delete') {
      let deptsList = window.departmentsList || [];
      let deptOptions = deptsList.map(d => `<option value="${d.name}">${d.name}</option>`).join("");
      fieldsHtml = `
        <div class="form-group"><label>Select Department to Delete *</label>
          <select id="crud-dept-select" class="form-input" required>
            <option value="">-- Choose Department --</option>
            ${deptOptions}
          </select>
        </div>
      `;
    }
  }
  
  fieldsDiv.innerHTML = fieldsHtml;
  modal.classList.add("active");
}

function closeCrudModal() {
  const modal = document.getElementById("dmd-crud-modal");
  if (modal) modal.classList.remove("active");
  dmdSelectedEntity = null;
  dmdSelectedAction = null;
}

window.loadCrudJobDetails = function(kp) {
  const job = jobs.find(j => j.kpNumber === kp);
  const detailDiv = document.getElementById("crud-job-edit-details");
  if (job && detailDiv) {
    detailDiv.classList.remove("hidden");
    detailDiv.innerHTML = `
      <div class="form-group"><label>Part Name *</label><input type="text" id="crud-job-part" class="form-input" required value="${job.partName}"></div>
      <div class="form-group"><label>Customer *</label><input type="text" id="crud-job-customer" class="form-input" required value="${job.customer}"></div>
      <div class="form-group"><label>Quantity *</label><input type="number" id="crud-job-qty" class="form-input" required value="${job.quantity}"></div>
      <div class="form-group"><label>Process Type *</label>
        <select id="crud-job-process" class="form-input">
          <option value="Plasma" ${job.processType === 'Plasma' ? 'selected' : ''}>Plasma</option>
          <option value="HCOS" ${job.processType === 'HCOS' ? 'selected' : ''}>HCOS</option>
          <option value="HVOF" ${job.processType === 'HVOF' ? 'selected' : ''}>HVOF</option>
        </select>
      </div>
      <div class="form-group"><label>Priority *</label>
        <select id="crud-job-priority" class="form-input">
          <option value="Normal" ${job.priority === 'Normal' ? 'selected' : ''}>Normal</option>
          <option value="High" ${job.priority === 'High' ? 'selected' : ''}>High</option>
          <option value="Critical" ${job.priority === 'Critical' ? 'selected' : ''}>Critical</option>
        </select>
      </div>
      <div class="form-group"><label>Stage *</label>
        <select id="crud-job-stage" class="form-input">
          <option value="Inspection" ${job.currentDepartment === 'Inspection' ? 'selected' : ''}>Inspection</option>
          <option value="Masking" ${job.currentDepartment === 'Masking' ? 'selected' : ''}>Masking</option>
          <option value="Spraying" ${job.currentDepartment === 'Spraying' ? 'selected' : ''}>Spraying</option>
          <option value="Grinding" ${job.currentDepartment === 'Grinding' ? 'selected' : ''}>Grinding</option>
          <option value="Polishing" ${job.currentDepartment === 'Polishing' ? 'selected' : ''}>Polishing</option>
          <option value="Final Inspection" ${job.currentDepartment === 'Final Inspection' ? 'selected' : ''}>Final Inspection</option>
          <option value="Dispatch" ${job.currentDepartment === 'Dispatch' ? 'selected' : ''}>Dispatch</option>
        </select>
      </div>
      <div class="form-group"><label>Store Location</label><input type="text" id="crud-job-store" class="form-input" value="${job.storeLocation || ''}"></div>
    `;
  } else if (detailDiv) {
    detailDiv.classList.add("hidden");
  }
}

window.loadCrudMachineDetails = function(id) {
  const machine = machines.find(m => m.machineId === id);
  const detailDiv = document.getElementById("crud-machine-edit-details");
  if (machine && detailDiv) {
    detailDiv.classList.remove("hidden");
    detailDiv.innerHTML = `
      <div class="form-group"><label>Name *</label><input type="text" id="crud-machine-name" class="form-input" required value="${machine.name}"></div>
      <div class="form-group"><label>Type *</label><input type="text" id="crud-machine-type" class="form-input" required value="${machine.type}"></div>
      <div class="form-group"><label>Department Owner *</label><input type="text" id="crud-machine-dept" class="form-input" required value="${machine.department}"></div>
      <div class="form-group"><label>Status *</label>
        <select id="crud-machine-status" class="form-input">
          <option value="idle" ${machine.status === 'idle' ? 'selected' : ''}>idle</option>
          <option value="running" ${machine.status === 'running' ? 'selected' : ''}>running</option>
          <option value="maintenance" ${machine.status === 'maintenance' ? 'selected' : ''}>maintenance</option>
          <option value="offline" ${machine.status === 'offline' ? 'selected' : ''}>offline</option>
        </select>
      </div>
    `;
  } else if (detailDiv) {
    detailDiv.classList.add("hidden");
  }
}

window.loadCrudMaterialDetails = function(id) {
  const m = materials.find(x => x.materialId === id);
  const detailDiv = document.getElementById("crud-material-edit-details");
  if (m && detailDiv) {
    detailDiv.classList.remove("hidden");
    detailDiv.innerHTML = `
      <div class="form-group"><label>Name *</label><input type="text" id="crud-material-name" class="form-input" required value="${m.name}"></div>
      <div class="form-group"><label>Category *</label><input type="text" id="crud-material-category" class="form-input" required value="${m.category || m.type || ''}"></div>
      <div class="form-group"><label>Unit of Measure *</label>
        <select id="crud-material-unit" class="form-input">
          <option value="KG" ${m.unit === 'KG' ? 'selected' : ''}>KG</option>
          <option value="Gram" ${m.unit === 'Gram' ? 'selected' : ''}>Gram</option>
          <option value="Ltr" ${m.unit === 'Ltr' ? 'selected' : ''}>Ltr</option>
          <option value="Nos" ${m.unit === 'Nos' ? 'selected' : ''}>Nos</option>
        </select>
      </div>
      <div class="form-group"><label>Department *</label><input type="text" id="crud-material-dept" class="form-input" required value="${m.department || 'Masking'}"></div>
    `;
  } else if (detailDiv) {
    detailDiv.classList.add("hidden");
  }
}

window.loadCrudDeptDetails = function(name) {
  const deptsList = window.departmentsList || [];
  const d = deptsList.find(x => x.name === name);
  const detailDiv = document.getElementById("crud-dept-edit-details");
  if (d && detailDiv) {
    detailDiv.classList.remove("hidden");
    const locsStr = Array.isArray(d.allowedStoreLocations) ? d.allowedStoreLocations.join(", ") : (d.allowedStoreLocations || "");
    const reasonsStr = Array.isArray(d.allowedPauseReasons) ? d.allowedPauseReasons.join(", ") : (d.allowedPauseReasons || "");
    detailDiv.innerHTML = `
      <div class="form-group"><label>Sequence (1-10) *</label><input type="number" id="crud-dept-seq" class="form-input" required value="${d.sequence}"></div>
      <div class="form-group"><label>Allowed Store Locations (comma-separated)</label><input type="text" id="crud-dept-locations" class="form-input" value="${locsStr}"></div>
      <div class="form-group"><label>Allowed Pause Reasons (comma-separated)</label><input type="text" id="crud-dept-reasons" class="form-input" value="${reasonsStr}"></div>
    `;
  } else if (detailDiv) {
    detailDiv.classList.add("hidden");
  }
}

async function submitCrudForm(e) {
  e.preventDefault();
  
  const isMock = isMockMode();
  const db = !isMock ? firebase.firestore() : null;
  
  try {
    if (dmdSelectedEntity === 'job') {
      if (dmdSelectedAction === 'create') {
        const kp = document.getElementById("crud-job-kp").value.trim();
        const part = document.getElementById("crud-job-part").value.trim();
        const customer = document.getElementById("crud-job-customer").value.trim();
        const qty = Number(document.getElementById("crud-job-qty").value);
        const process = document.getElementById("crud-job-process").value;
        const priority = document.getElementById("crud-job-priority").value;
        const stage = document.getElementById("crud-job-stage").value;
        const store = document.getElementById("crud-job-store").value.trim();
        
        if (isMock) {
          const newJob = {
            kpNumber: kp, partName: part, customer: customer, quantity: qty,
            processType: process, priority: priority, currentDepartment: stage, status: "Pending",
            storeLocation: store, masking: { status: "Pending", materials: [], holdHistory: [] },
            spraying: { status: "Pending" }, grinding: { status: "Pending", holdHistory: [] }
          };
          jobs.push(newJob);
        } else {
          await db.collection("jobs").doc(`job_${kp}`).set({
            jobId: `job_${kp}`, kpNumber: kp, partName: part, customer: customer, quantity: qty,
            processType: process, priority: priority, currentStage: stage, currentStatus: "Pending",
            storeLocation: store, createdDate: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser?.email || "System", lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
            masking: { status: "Pending", materials: [], holdHistory: [] },
            spraying: { status: "Pending" }, grinding: { status: "Pending", holdHistory: [] },
            polishing: { status: "Pending" }, finalInspection: { status: "Pending" }, dispatch: { status: "Pending" }
          });
        }
        await createAuditLog(currentUser?.email || "System", kp, `Created Job: ${kp} (${part})`);
        
      } else if (dmdSelectedAction === 'edit') {
        const kp = document.getElementById("crud-job-select").value;
        const part = document.getElementById("crud-job-part").value.trim();
        const customer = document.getElementById("crud-job-customer").value.trim();
        const qty = Number(document.getElementById("crud-job-qty").value);
        const process = document.getElementById("crud-job-process").value;
        const priority = document.getElementById("crud-job-priority").value;
        const stage = document.getElementById("crud-job-stage").value;
        const store = document.getElementById("crud-job-store").value.trim();
        
        if (isMock) {
          const j = jobs.find(x => x.kpNumber === kp);
          if (j) {
            j.partName = part; j.customer = customer; j.quantity = qty;
            j.processType = process; j.priority = priority; j.currentDepartment = stage;
            j.storeLocation = store;
          }
        } else {
          const snap = await db.collection("jobs").where("kpNumber", "==", kp).get();
          if (!snap.empty) {
            await snap.docs[0].ref.update({
              partName: part, customer: customer, quantity: qty,
              processType: process, priority: priority, currentStage: stage,
              storeLocation: store, lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
            });
          }
        }
        await createAuditLog(currentUser?.email || "System", kp, `Updated Job: ${kp}`);
        
      } else if (dmdSelectedAction === 'delete') {
        const kp = document.getElementById("crud-job-select").value;
        if (!confirm(`Are you sure you want to delete Job ${kp}?`)) return;
        
        if (isMock) {
          jobs = jobs.filter(x => x.kpNumber !== kp);
        } else {
          const snap = await db.collection("jobs").where("kpNumber", "==", kp).get();
          if (!snap.empty) {
            await snap.docs[0].ref.delete();
          }
        }
        await createAuditLog(currentUser?.email || "System", kp, `Deleted Job: ${kp}`);
      }
    }
    
    else if (dmdSelectedEntity === 'machine') {
      if (dmdSelectedAction === 'create') {
        const id = document.getElementById("crud-machine-id").value.trim();
        const name = document.getElementById("crud-machine-name").value.trim();
        const type = document.getElementById("crud-machine-type").value.trim();
        const dept = document.getElementById("crud-machine-dept").value.trim();
        const status = document.getElementById("crud-machine-status").value;
        
        if (isMock) {
          machines.push({ machineId: id, name, type, department: dept, status });
        } else {
          await db.collection("machines").doc(id).set({
            machineId: id, name, type, department: dept, status, lastMaintenance: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
        await createAuditLog(currentUser?.email || "System", null, `Created Machine: ${name}`);
        
      } else if (dmdSelectedAction === 'edit') {
        const id = document.getElementById("crud-machine-select").value;
        const name = document.getElementById("crud-machine-name").value.trim();
        const type = document.getElementById("crud-machine-type").value.trim();
        const dept = document.getElementById("crud-machine-dept").value.trim();
        const status = document.getElementById("crud-machine-status").value;
        
        if (isMock) {
          const m = machines.find(x => x.machineId === id);
          if (m) {
            m.name = name; m.type = type; m.department = dept; m.status = status;
          }
        } else {
          await db.collection("machines").doc(id).update({
            name, type, department: dept, status
          });
        }
        await createAuditLog(currentUser?.email || "System", null, `Updated Machine: ${name}`);
        
      } else if (dmdSelectedAction === 'delete') {
        const id = document.getElementById("crud-machine-select").value;
        if (!confirm(`Are you sure you want to delete Machine ${id}?`)) return;
        
        if (isMock) {
          machines = machines.filter(x => x.machineId !== id);
        } else {
          await db.collection("machines").doc(id).delete();
        }
        await createAuditLog(currentUser?.email || "System", null, `Deleted Machine: ${id}`);
      }
    }
    
    else if (dmdSelectedEntity === 'material') {
      if (dmdSelectedAction === 'create') {
        const id = document.getElementById("crud-material-id").value.trim();
        const name = document.getElementById("crud-material-name").value.trim();
        const category = document.getElementById("crud-material-category").value.trim();
        const unit = document.getElementById("crud-material-unit").value;
        const dept = document.getElementById("crud-material-dept").value.trim();
        
        if (isMock) {
          materials.push({ id, name, type: category, category, unit, department: dept, isActive: true });
        } else {
          await db.collection("master_materials").doc(id).set({
            materialId: id, name, category, unit, department: dept, isActive: true
          });
        }
        await createAuditLog(currentUser?.email || "System", null, `Added Material: ${name}`);
        
      } else if (dmdSelectedAction === 'edit') {
        const id = document.getElementById("crud-material-select").value;
        const name = document.getElementById("crud-material-name").value.trim();
        const category = document.getElementById("crud-material-category").value.trim();
        const unit = document.getElementById("crud-material-unit").value;
        const dept = document.getElementById("crud-material-dept").value.trim();
        
        if (isMock) {
          const m = materials.find(x => x.materialId === id);
          if (m) {
            m.name = name; m.type = category; m.category = category; m.unit = unit; m.department = dept;
          }
        } else {
          await db.collection("master_materials").doc(id).update({
            name, category, unit, department: dept
          });
        }
        await createAuditLog(currentUser?.email || "System", null, `Updated Material: ${name}`);
        
      } else if (dmdSelectedAction === 'delete') {
        const id = document.getElementById("crud-material-select").value;
        if (!confirm(`Are you sure you want to delete Material ${id}?`)) return;
        
        if (isMock) {
          materials = materials.filter(x => x.materialId !== id);
        } else {
          await db.collection("master_materials").doc(id).delete();
        }
        await createAuditLog(currentUser?.email || "System", null, `Deleted Material: ${id}`);
      }
    }
    
    else if (dmdSelectedEntity === 'department') {
      if (dmdSelectedAction === 'create') {
        const name = document.getElementById("crud-dept-name").value.trim();
        const seq = Number(document.getElementById("crud-dept-seq").value);
        const locs = document.getElementById("crud-dept-locations").value.split(",").map(x => x.trim()).filter(Boolean);
        const reasons = document.getElementById("crud-dept-reasons").value.split(",").map(x => x.trim()).filter(Boolean);
        
        if (isMock) {
          window.departmentsList = window.departmentsList || [];
          window.departmentsList.push({ name, sequence: seq, allowedStoreLocations: locs, allowedPauseReasons: reasons });
        } else {
          await db.collection("departments").doc(name).set({
            name, sequence: seq, allowedStoreLocations: locs, allowedPauseReasons: reasons
          });
        }
        await createAuditLog(currentUser?.email || "System", null, `Created Department: ${name}`);
        
      } else if (dmdSelectedAction === 'edit') {
        const name = document.getElementById("crud-dept-select").value;
        const seq = Number(document.getElementById("crud-dept-seq").value);
        const locs = document.getElementById("crud-dept-locations").value.split(",").map(x => x.trim()).filter(Boolean);
        const reasons = document.getElementById("crud-dept-reasons").value.split(",").map(x => x.trim()).filter(Boolean);
        
        if (isMock) {
          const d = window.departmentsList.find(x => x.name === name);
          if (d) {
            d.sequence = seq; d.allowedStoreLocations = locs; d.allowedPauseReasons = reasons;
          }
        } else {
          await db.collection("departments").doc(name).update({
            sequence: seq, allowedStoreLocations: locs, allowedPauseReasons: reasons
          });
        }
        await createAuditLog(currentUser?.email || "System", null, `Updated Department: ${name}`);
        
      } else if (dmdSelectedAction === 'delete') {
        const name = document.getElementById("crud-dept-select").value;
        if (!confirm(`Are you sure you want to delete Department ${name}?`)) return;
        
        if (isMock) {
          window.departmentsList = window.departmentsList.filter(x => x.name !== name);
        } else {
          await db.collection("departments").doc(name).delete();
        }
        await createAuditLog(currentUser?.email || "System", null, `Deleted Department: ${name}`);
      }
    }
    
    alert("Operation completed successfully!");
    closeCrudModal();
    renderAll();
  } catch(err) {
    console.error(err);
    alert("Error performing operation: " + err.message);
  }
}

async function saveAndApproveUserDmd(uid) {
  const roleSelect = document.getElementById(`dmd-user-role-select-${uid}`);
  const deptSelect = document.getElementById(`dmd-user-dept-select-${uid}`);
  if (!roleSelect || !deptSelect) return;
  const role = roleSelect.value;
  const department = deptSelect.value;
  
  if (isMockMode()) {
    const mockUsers = MOCK_DB.getUsers();
    const u = mockUsers.find(x => x.uid === uid);
    if (u) {
      u.role = role;
      u.department = department;
      u.active = true;
      u.emailVerified = true;
      MOCK_DB.saveUsers(mockUsers);
    }
  } else {
    try {
      const db = firebase.firestore();
      await db.collection("users").doc(uid).update({
        role: role,
        department: department,
        active: true,
        emailVerified: true
      });
    } catch(err) {
      alert("Error saving: " + err.message);
      return;
    }
  }
  alert("User upgraded successfully!");
  createAuditLog(currentUser.email, null, `Approved & assigned role ${role.toUpperCase()} to user ID: ${uid}`);
  renderAll();
}

async function toggleUserStatusDmd(uid) {
  if (isMockMode()) {
    const mockUsers = MOCK_DB.getUsers();
    const u = mockUsers.find(x => x.uid === uid);
    if (u) {
      u.active = !u.active;
      MOCK_DB.saveUsers(mockUsers);
    }
  } else {
    try {
      const db = firebase.firestore();
      const doc = await db.collection("users").doc(uid).get();
      if (doc.exists) {
        const cur = doc.data().active || false;
        await db.collection("users").doc(uid).update({ active: !cur });
      }
    } catch(err) {
      alert("Error: " + err.message);
      return;
    }
  }
  renderAll();
}
