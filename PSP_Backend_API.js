/**
 * PSP_Backend_API
 * Google Apps Script Web App API for Plasma Spray Processors MES
 * 
 * Instructions:
 * 1. Create a new Google Apps Script project called "PSP_Backend_API" (stand-alone or bound to your PSP_MES_DATABASE spreadsheet).
 * 2. If it is stand-alone, configure Script Properties in Project Settings:
 *    - SPREADSHEET_ID: The ID of your PSP_MES_DATABASE Google Spreadsheet.
 * 3. Replace all code in the script editor with this file contents.
 * 4. Click "Deploy" > "New deployment".
 *    - Select type: "Web app"
 *    - Execute as: "Me" (your Google Account)
 *    - Who has access: "Anyone"
 * 5. Copy the generated Web App URL and paste it as the `scriptUrl` in `app.js`.
 */

function doGet(e) {
  try {
    const rawAction = (e && e.parameter && e.parameter.action) ? String(e.parameter.action).trim() : "";
    const action = rawAction.toLowerCase();
    
    if (action === "getjobs" || action === "jobs") {
      return getJobsHandler_(e);
    } else if (action === "getjobbykp" || action === "jobbykp") {
      return getJobByKPHandler_(e);
    } else if (action === "getmaterialconsumption" || action === "materialconsumption") {
      return getMaterialConsumptionHandler_(e);
    } else if (action === "getdashboardstats" || action === "dashboardstats") {
      return getDashboardStatsHandler_(e);
    } else if (action === "getoperators" || action === "getusers" || action === "users") {
      return getOperatorsHandler_(e);
    } else if (action === "getmaterials" || action === "getmastermaterials" || action === "materials") {
      return getMaterialsHandler_(e);
    } else if (action === "getauditlogs" || action === "auditlogs") {
      return getAuditLogsHandler_(e);
    } else if (action === "getinspectionkps") {
      return getInspectionKPsHandler_(e);
    } else if (action === "getinspectionrecord") {
      return getInspectionRecordHandler_(e);
    } else if (action === "debugjobs") {
      return jsonResponse_(getSheetDataJson_("Jobs_Master"));
    } else if (action === "debugmaterials") {
      return jsonResponse_(getSheetDataJson_("Master_Materials"));
    } else if (action === "debugconsumption") {
      return jsonResponse_(getSheetDataJson_("Material_Consumption"));
    } else if (action === "debugheaders") {
      // Return the raw headers from each sheet for debugging
      const ss = getSpreadsheet_();
      const result = {};
      ["Master_Materials", "Material_Consumption", "Jobs_Master", "Process_History", "Audit_Log"].forEach(name => {
        const sheet = ss.getSheetByName(name);
        if (sheet && sheet.getLastColumn() > 0) {
          result[name] = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
        } else {
          result[name] = null;
        }
      });
      return jsonResponse_(result);
    }
    
    return jsonResponse_({ success: false, error: "Invalid GET action: " + rawAction });
  } catch (error) {
    return jsonResponse_({ success: false, error: String(error) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    // Invalidate the cache for inspection master records on any write/update
    try {
      CacheService.getScriptCache().remove("INSPECTION_MASTER_RECORDS");
    } catch (cErr) {
      console.warn("Failed to invalidate inspection cache:", cErr);
    }

    const data = parseRequestData_(e);
    if (!data.type && !data.action) {
      return jsonResponse_({ success: false, error: "Missing request action/type" });
    }

    const reqType = String(data.type || data.action || "").trim().toUpperCase();

    // ── START CYCLE ───────────────────────────────────────────────────────────
    if (reqType === "START_CYCLE" || reqType === "STARTCYCLE") {
      updateProcessHistory_(data.kpNo, data.stage, data.operatorName, data.shift, data.startTime, undefined, "In Progress", 0, data.holdHistory || []);
      updateJobsMaster_(data.kpNo, {
        status: "In Progress",
        operatorname: data.operatorName,
        shift: data.shift
      });
      logAudit_(data.operatorName, data.stage, data.kpNo, "Cycle Started", "Commenced " + data.stage + " process on " + (data.shift || "A Shift"));
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "START_CYCLE" });
    }

    // ── PAUSE CYCLE ───────────────────────────────────────────────────────────
    if (reqType === "PAUSE_CYCLE" || reqType === "PAUSECYCLE") {
      updateProcessHistory_(data.kpNo, data.stage, data.operatorName, undefined, undefined, new Date().toISOString(), "Hold", data.activeTimeMs, data.holdHistory || []);
      updateJobsMaster_(data.kpNo, {
        status: "Hold"
      });
      logAudit_(data.operatorName, data.stage, data.kpNo, "Cycle Paused", "Put on Hold (Reason: " + (data.holdReason || "N/A") + ")");
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "PAUSE_CYCLE" });
    }

    // ── RESUME CYCLE ──────────────────────────────────────────────────────────
    if (reqType === "RESUME_CYCLE" || reqType === "RESUMECYCLE") {
      updateProcessHistory_(data.kpNo, data.stage, data.operatorName, undefined, new Date().toISOString(), undefined, "In Progress", undefined, data.holdHistory || []);
      updateJobsMaster_(data.kpNo, {
        status: "In Progress"
      });
      logAudit_(data.operatorName, data.stage, data.kpNo, "Cycle Resumed", "Job returned to active state");
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "RESUME_CYCLE" });
    }

    // ── END CYCLE ─────────────────────────────────────────────────────────────
    if (reqType === "END_CYCLE" || reqType === "ENDCYCLE") {
      updateProcessHistory_(data.kpNo, data.stage, data.operatorName, undefined, undefined, data.endTime, "Completed", data.activeTimeMs, data.holdHistory || []);
      updateJobsMaster_(data.kpNo, {
        currentdepartment: data.nextStage,
        status: data.nextStage === "Dispatched" ? "Completed" : "Pending",
        operatorname: "",
        shift: ""
      });
      logAudit_(data.operatorName, data.stage, data.kpNo, "Cycle Ended", "Completed " + data.stage + " process, routed to " + data.nextStage);
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "END_CYCLE" });
    }

    // ── ADD MATERIAL CONSUMPTION ──────────────────────────────────────────────
    if (reqType === "ADD_MATERIAL_CONSUMPTION" || reqType === "ADDMATERIALCONSUMPTION") {
      addMaterialConsumption_(data.kpNo, data.stage, data.materialName, data.materialType, data.batch, data.unit, data.plannedQty, data.actualQty, data.operatorName);
      logAudit_(data.operatorName, data.stage, data.kpNo, "Material Added", "Added material " + data.materialName + " (Batch: " + (data.batch || "N/A") + ")");
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "ADD_MATERIAL_CONSUMPTION" });
    }

    // ── DELETE MATERIAL CONSUMPTION ───────────────────────────────────────────
    if (reqType === "DELETE_MATERIAL_CONSUMPTION" || reqType === "DELETEMATERIALCONSUMPTION") {
      const ss = getSpreadsheet_();
      const mcSheet = ss.getSheetByName("Material_Consumption");
      if (mcSheet) {
        const mcHeaders = mcSheet.getRange(1, 1, 1, mcSheet.getLastColumn()).getValues()[0].map(cleanHeader_);
        let kpCol = -1, stageCol = -1, nameCol = -1;
        mcHeaders.forEach((h, idx) => {
          if (matchesField_(h, "kpnumber")) kpCol = idx;
          if (matchesField_(h, "stage")) stageCol = idx;
          if (matchesField_(h, "materialname")) nameCol = idx;
        });
        const mcDataRange = mcSheet.getDataRange().getValues();
        
        if (kpCol !== -1 && stageCol !== -1 && nameCol !== -1) {
          for (let i = mcDataRange.length - 1; i >= 1; i--) {
            if (
              String(mcDataRange[i][kpCol]) === String(data.kpNo) &&
              String(mcDataRange[i][stageCol]) === String(data.stage) &&
              String(mcDataRange[i][nameCol]) === String(data.materialName)
            ) {
              mcSheet.deleteRow(i + 1);
              break;
            }
          }
        }
      }
      logAudit_(data.operatorName, data.stage, data.kpNo, "Material Removed", "Removed material " + data.materialName);
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "DELETE_MATERIAL_CONSUMPTION" });
    }

    // ── CREATE AUDIT LOG ──────────────────────────────────────────────────────
    if (reqType === "CREATE_AUDIT_LOG" || reqType === "CREATEAUDITLOG") {
      logAudit_(data.user, data.department, data.kpNo, data.action, data.details);
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "CREATE_AUDIT_LOG" });
    }

    // ── CREATE JOB ────────────────────────────────────────────────────────────
    if (reqType === "CREATE_JOB" || reqType === "CREATEJOB") {
      createJobInMaster_({
        kpnumber: data.kpNo,
        partname: data.partName,
        customer: data.customer,
        quantity: data.quantity,
        processtype: data.processType,
        priority: data.priority,
        inspectiondate: data.inspectionDate,
        currentdepartment: "Inspection",
        status: "Inspection Pending",
        operatorname: "",
        shift: ""
      });
      logAudit_("System", "Inspection", data.kpNo, "Job Registered", "Registered new component " + data.partName);
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "CREATE_JOB" });
    }

    return jsonResponse_({ success: false, error: "Invalid request action/type: " + reqType });

  } catch (error) {
    return jsonResponse_({ success: false, error: String(error) });
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {}
  }
}

// ── GET HANDLER IMPLEMENTATIONS ───────────────────────────────────────────────

function getSpreadsheet_() {
  // If the script is bound to the spreadsheet, getActiveSpreadsheet works.
  // Otherwise, fallback to Spreadsheet ID from Script Properties.
  let ss = null;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {}
  
  if (!ss) {
    let sheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
    if (!sheetId) {
      sheetId = "1e1k1YNorLDXe_peUChVdcqEoLgkYzM_a8HPhzymgfAM";
    }
    ss = SpreadsheetApp.openById(sheetId);
  }
  return ss;
}

function getSheetDataJson_(sheetName) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  const lastCol = sheet.getLastColumn();
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data.shift().map(h => String(h).trim());
  return data
    .filter(row => row.some(cell => String(cell ?? "").trim() !== ""))
    .map(row => {
      let obj = {};
      headers.forEach((h, index) => {
        obj[h] = row[index];
      });
      return obj;
    });
}

function cleanHeader_(h) {
  return String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * matchesField_(cleanedHeader, fieldCategory)
 * Returns true if the cleaned header matches the given field category.
 * Field categories: "kpnumber", "stage", "materialname", "materialtype", 
 *   "batch", "unit", "plannedqty", "actualqty"
 */
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
    case "processtype":
      return ["processtype", "process", "type"].indexOf(h) !== -1;
    case "priority":
      return ["priority"].indexOf(h) !== -1;
    case "inspectiondate":
      return ["inspectiondate", "createddate"].indexOf(h) !== -1;
    case "receiveddate":
      return ["receiveddate"].indexOf(h) !== -1;
    case "stage":
      return ["stage", "process", "department", "currentdepartment", "currentprocess", "currentstage"].indexOf(h) !== -1;
    case "status":
      return ["status", "globalstatus", "currentstatus"].indexOf(h) !== -1;
    case "operatorname":
      return ["operatorname", "operator", "user", "username"].indexOf(h) !== -1;
    case "shift":
      return ["shift"].indexOf(h) !== -1;
    case "starttime":
      return ["starttime", "start", "timestamp", "time"].indexOf(h) !== -1;
    case "endtime":
      return ["endtime", "end"].indexOf(h) !== -1;
    case "activetimems":
      return ["activetimems", "durationms", "duration", "activetime", "activetimems"].indexOf(h) !== -1;
    case "holdhistory":
      return ["holdhistory"].indexOf(h) !== -1;
    case "materialname":
      return ["materialname", "name", "material", "itemname", "item", "matname", "consumable", "consumablename"].indexOf(h) !== -1;
    case "materialtype":
      return ["type", "materialtype", "mattype", "category", "materialcategory", "itemtype"].indexOf(h) !== -1;
    case "batch":
      return ["batch", "batchno", "batchnumber", "batchid", "lotno", "lot"].indexOf(h) !== -1;
    case "unit":
      return ["unit", "uom", "unitofmeasure", "units", "measureunit"].indexOf(h) !== -1;
    case "plannedqty":
      return ["plannedqty", "planned", "plannedquantity", "planqty", "requiredqty", "required", "targetqty", "stdqty", "standardqty"].indexOf(h) !== -1;
    case "actualqty":
      return ["actualqty", "actual", "actualquantity", "usedqty", "used", "consumed", "consumedqty", "realqty", "actualused"].indexOf(h) !== -1;
    case "action":
      return ["action"].indexOf(h) !== -1;
    case "details":
      return ["details", "notes", "remark", "remarks"].indexOf(h) !== -1;
    case "createdby":
      return ["createdby", "creator"].indexOf(h) !== -1;
    case "lastupdated":
      return ["lastupdated", "updatedat", "lastupdatedtime"].indexOf(h) !== -1;
    default:
      return h === cleanHeader_(field);
  }
}


function formatDateValue_(val) {
  if (!val) return "";
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return d.toISOString().split('T')[0];
  } catch (e) {
    return String(val);
  }
}

function getJobsHandler_(e) {
  const jobsData = getSheetDataJson_("Jobs_Master");
  const historyData = getSheetDataJson_("Process_History");
  const consumptionData = getSheetDataJson_("Material_Consumption");

  const mappedJobs = jobsData.map(j => {
    let kpNumber = "";
    let partName = "";
    let customer = "";
    let quantity = 1;
    let processType = "";
    let priority = "Normal";
    let inspectionDate = "";
    let receivedDate = "";
    let currentDepartment = "";
    let status = "Pending";
    let operatorName = "";
    let shift = "";

    for (let rawKey in j) {
      const cleanKey = cleanHeader_(rawKey);
      const val = j[rawKey];
      if (matchesField_(cleanKey, "kpnumber")) {
        kpNumber = String(val);
      } else if (matchesField_(cleanKey, "partname")) {
        partName = String(val);
      } else if (matchesField_(cleanKey, "customer")) {
        customer = String(val);
      } else if (matchesField_(cleanKey, "quantity")) {
        quantity = Number(val) || 0;
      } else if (matchesField_(cleanKey, "processtype")) {
        processType = String(val);
      } else if (matchesField_(cleanKey, "priority")) {
        priority = String(val);
      } else if (matchesField_(cleanKey, "inspectiondate")) {
        inspectionDate = formatDateValue_(val);
      } else if (matchesField_(cleanKey, "receiveddate")) {
        receivedDate = formatDateValue_(val);
      } else if (matchesField_(cleanKey, "stage")) {
        currentDepartment = String(val);
      } else if (matchesField_(cleanKey, "status")) {
        status = String(val);
      } else if (matchesField_(cleanKey, "operatorname")) {
        operatorName = String(val);
      } else if (matchesField_(cleanKey, "shift")) {
        shift = String(val);
      }
    }

    const jobObj = {
      kpNumber,
      partName,
      customer,
      quantity,
      processType,
      priority,
      inspectionDate,
      receivedDate,
      currentDepartment,
      status,
      operatorName,
      shift,
      masking: { status: "Pending", materials: [], holdHistory: [] },
      spraying: { status: "Pending" },
      grinding: { status: "Pending" },
      polishing: { status: "Pending" },
      finalInspection: { status: "Pending" },
      dispatch: { status: "Pending" }
    };

    const jobHistory = historyData.filter(h => {
      let hKp = "";
      for (let k in h) {
        if (matchesField_(k, "kpnumber")) {
          hKp = String(h[k]);
        }
      }
      return hKp === kpNumber;
    });

    jobHistory.forEach(h => {
      let stage = "";
      let hStatus = "";
      let hOp = "";
      let hShift = "";
      let hStart = null;
      let hEnd = null;
      let hActiveTime = 0;
      let hHoldHistory = [];

      for (let k in h) {
        const ck = cleanHeader_(k);
        const val = h[k];
        if (matchesField_(ck, "stage")) {
          stage = String(val);
        } else if (matchesField_(ck, "status")) {
          hStatus = String(val);
        } else if (matchesField_(ck, "operatorname")) {
          hOp = String(val);
        } else if (matchesField_(ck, "shift")) {
          hShift = String(val);
        } else if (matchesField_(ck, "starttime")) {
          hStart = val ? new Date(val).toISOString() : null;
        } else if (matchesField_(ck, "endtime")) {
          hEnd = val ? new Date(val).toISOString() : null;
        } else if (matchesField_(ck, "activetimems")) {
          hActiveTime = Number(val) || 0;
        } else if (ck === "holdhistory") {
          if (val) {
            try {
              hHoldHistory = JSON.parse(val);
            } catch (e) {
              hHoldHistory = [];
            }
          }
        }
      }

      let stageKey = stage.toLowerCase().replace(/[^a-z]/g, "");
      if (stageKey === "finalinspection") stageKey = "finalInspection";

      if (stageKey === "masking" || stageKey === "spraying" || stageKey === "grinding" || stageKey === "polishing" || stageKey === "finalInspection" || stageKey === "dispatch") {
        jobObj[stageKey] = {
          operatorName: hOp,
          shift: hShift,
          status: hStatus,
          startTime: hStart,
          endTime: hEnd,
          durationMs: hActiveTime,
          activeTimeMs: hActiveTime,
          lastStartedAt: hStatus === "In Progress" ? hStart : null,
          lastPausedAt: hStatus === "Hold" ? hEnd : null,
          holdHistory: hHoldHistory,
          materials: []
        };
      }
    });

    const jobConsumption = consumptionData.filter(c => {
      let cKp = "";
      for (let k in c) {
        if (matchesField_(k, "kpnumber")) {
          cKp = String(c[k]);
        }
      }
      return cKp === kpNumber;
    });

    jobObj.masking.materials = jobConsumption.map(c => {
      let mName = "";
      let mType = "";
      let mBatch = "";
      let mUnit = "";
      let mPlanned = 0;
      let mActual = 0;

      for (let k in c) {
        const ck = cleanHeader_(k);
        const val = c[k];
        if (matchesField_(ck, "materialname")) {
          mName = String(val);
        } else if (matchesField_(ck, "materialtype")) {
          mType = String(val);
        } else if (matchesField_(ck, "batch")) {
          mBatch = String(val);
        } else if (matchesField_(ck, "unit")) {
          mUnit = String(val);
        } else if (matchesField_(ck, "plannedqty")) {
          mPlanned = Number(val) || 0;
        } else if (matchesField_(ck, "actualqty")) {
          mActual = Number(val) || 0;
        }
      }

      return {
        name: mName,
        type: mType,
        batch: mBatch,
        unit: mUnit,
        plannedQty: mPlanned,
        actualQty: mActual
      };
    });

    // Ensure the current department's stage status matches the overall job status
    if (currentDepartment) {
      let currentStageKey = currentDepartment.toLowerCase().replace(/[^a-z]/g, "");
      if (currentStageKey === "finalinspection") currentStageKey = "finalInspection";
      
      if (jobObj[currentStageKey] && jobObj[currentStageKey].status === "Completed") {
        const activeStatus = (status && status.trim() !== "") ? status : "Pending";
        const stageStatus = (activeStatus.indexOf("Pending") !== -1) ? "Pending" : activeStatus;
        jobObj[currentStageKey] = {
          operatorName: "",
          shift: "",
          status: stageStatus,
          startTime: null,
          endTime: null,
          durationMs: 0,
          activeTimeMs: 0,
          lastStartedAt: null,
          lastPausedAt: null,
          holdHistory: [],
          materials: []
        };
      }
    }

    return jobObj;
  });

  const filteredJobs = mappedJobs.filter(job => job.kpNumber && job.kpNumber.trim() !== "");
  return jsonResponse_(filteredJobs);
}

function getJobByKPHandler_(e) {
  const kp = (e && e.parameter && e.parameter.kpNo) ? String(e.parameter.kpNo).trim() : "";
  if (!kp) return jsonResponse_({ success: false, error: "Missing kpNo parameter" });

  const response = getJobsHandler_(e);
  const jobsList = JSON.parse(response.getContent());
  const job = jobsList.find(j => j.kpNumber === kp);
  if (!job) return jsonResponse_({ success: false, error: "Job not found" });

  return jsonResponse_(job);
}

function getMaterialConsumptionHandler_(e) {
  const kp = (e && e.parameter && e.parameter.kpNo) ? String(e.parameter.kpNo).trim() : "";
  const consumptionData = getSheetDataJson_("Material_Consumption");
  let result = consumptionData;
  if (kp) {
    result = result.filter(c => {
      let cKp = "";
      for (let k in c) {
        if (matchesField_(k, "kpnumber")) {
          cKp = String(c[k]);
        }
      }
      return cKp === kp;
    });
  }
  return jsonResponse_(result);
}

function getDashboardStatsHandler_(e) {
  const stage = (e && e.parameter && e.parameter.stage) ? String(e.parameter.stage).trim() : "";
  const response = getJobsHandler_(e);
  const jobsList = JSON.parse(response.getContent());

  const stageJobs = stage ? jobsList.filter(j => j.currentDepartment.toLowerCase() === stage.toLowerCase()) : jobsList;
  const pending = stageJobs.filter(j => j.status === "Pending" || j.status === "Inspection Pending").length;
  const running = stageJobs.filter(j => j.status === "In Progress").length;
  const hold = stageJobs.filter(j => j.status === "Hold").length;
  const completed = stageJobs.filter(j => j.status === "Completed").length;

  return jsonResponse_({
    pendingJobs: pending,
    runningJobs: running,
    holdJobs: hold,
    completedJobs: completed,
    totalJobs: stageJobs.length
  });
}

function getOperatorsHandler_(e) {
  const usersData = getSheetDataJson_("Users");
  const mapped = usersData.map(u => {
    let id = "";
    let name = "";
    let email = "";
    let role = "";
    let department = "";
    let shift = "";
    let active = true;

    for (let k in u) {
      const ck = cleanHeader_(k);
      const val = u[k];
      if (ck === "id" || ck === "employeeid" || ck === "uid") id = String(val);
      else if (ck === "name" || ck === "username") name = String(val);
      else if (ck === "email") email = String(val);
      else if (ck === "role") role = String(val);
      else if (ck === "department") department = String(val);
      else if (ck === "shift") shift = String(val);
      else if (ck === "active" || ck === "status") active = (String(val).toLowerCase() === "true" || val === true || String(val).toLowerCase() === "active");
    }

    return { id, name, email, role, department, shift, active };
  });
  return jsonResponse_(mapped);
}

function getMaterialsHandler_(e) {
  const materialsData = getSheetDataJson_("Master_Materials");
  const mapped = materialsData.map(m => {
    let name = "";
    let type = "";
    let batch = "";
    let unit = "";
    let plannedQty = 0;
    let actualQty = 0;
    let id = "";

    for (let k in m) {
      const ck = cleanHeader_(k);
      const val = m[k];
      if (matchesField_(ck, "materialname")) name = String(val);
      else if (matchesField_(ck, "materialtype")) type = String(val);
      else if (matchesField_(ck, "batch")) batch = String(val);
      else if (matchesField_(ck, "unit")) unit = String(val);
      else if (matchesField_(ck, "plannedqty")) plannedQty = Number(val) || 0;
      else if (matchesField_(ck, "actualqty")) actualQty = Number(val) || 0;
      else if (ck === "id" || ck === "materialid" || ck === "sno" || ck === "srno" || ck === "serialno") id = String(val);
    }

    return { id, name, type, batch, unit, plannedQty, actualQty };
  });
  return jsonResponse_(mapped);
}

function getAuditLogsHandler_(e) {
  const data = getSheetDataJson_("Audit_Log");
  const mapped = data.map(log => {
    let timestamp = "";
    let user = "";
    let department = "";
    let kpNumber = "";
    let action = "";
    let details = "";

    for (let k in log) {
      const ck = cleanHeader_(k);
      const val = log[k];
      if (ck === "timestamp" || ck === "time") {
        timestamp = val ? new Date(val).toISOString() : "";
      } else if (ck === "user" || ck === "operator" || ck === "username") {
        user = String(val);
      } else if (ck === "department" || ck === "stage") {
        department = String(val);
      } else if (ck === "kpnumber" || ck === "kpno" || ck === "jobid") {
        kpNumber = String(val);
      } else if (ck === "action") {
        action = String(val);
      } else if (ck === "details" || ck === "notes" || ck === "remark") {
        details = String(val);
      }
    }

    return { timestamp, user, department, kpNumber, action, details };
  });

  mapped.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return jsonResponse_(mapped);
}

// ── INTERNAL DATABASE OPERATIONS ──────────────────────────────────────────────

function findRowInSheet_(sheet, field1, val1, field2, val2) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return -1;
  const headers = data[0].map(cleanHeader_);
  
  const colIndices1 = [];
  const colIndices2 = [];
  
  for (let idx = 0; idx < headers.length; idx++) {
    const h = headers[idx];
    if (matchesField_(h, field1)) {
      colIndices1.push(idx);
    }
    if (field2 && matchesField_(h, field2)) {
      colIndices2.push(idx);
    }
  }
  
  if (colIndices1.length === 0) return -1;
  
  const targetVal1 = String(val1).trim();
  const targetVal2 = field2 ? String(val2).trim() : null;
  
  for (let i = 1; i < data.length; i++) {
    // Check if any of the matched columns for field1 contain val1
    const match1 = colIndices1.some(colIdx => String(data[i][colIdx]).trim() === targetVal1);
    if (match1) {
      if (!field2) {
        return i + 1;
      }
      // Check if any of the matched columns for field2 contain val2
      const match2 = colIndices2.some(colIdx => String(data[i][colIdx]).trim() === targetVal2);
      if (match2) {
        return i + 1;
      }
    }
  }
  return -1;
}

function updateProcessHistory_(kpNo, stage, operatorName, shift, startTime, endTime, status, activeTimeMs, holdHistoryObj) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName("Process_History");
  if (!sheet) throw new Error("Process_History sheet not found");

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(cleanHeader_);
  const rowIndex = findRowInSheet_(sheet, "kpnumber", kpNo, "stage", stage);

  const updatesObj = {};
  if (operatorName !== undefined) updatesObj["operatorname"] = operatorName;
  if (shift !== undefined) updatesObj["shift"] = shift;
  if (startTime !== undefined) updatesObj["starttime"] = startTime;
  if (endTime !== undefined) updatesObj["endtime"] = endTime;
  if (status !== undefined) updatesObj["status"] = status;
  if (activeTimeMs !== undefined) updatesObj["activetimems"] = activeTimeMs;
  if (holdHistoryObj !== undefined) updatesObj["holdhistory"] = typeof holdHistoryObj === "string" ? holdHistoryObj : JSON.stringify(holdHistoryObj);

  if (rowIndex !== -1) {
    const range = sheet.getRange(rowIndex, 1, 1, headers.length);
    const rowValues = range.getValues()[0];
    headers.forEach((h, index) => {
      const val = resolveFieldValue_(h, updatesObj);
      if (val !== undefined) {
        rowValues[index] = val;
      }
    });
    range.setValues([rowValues]);
  } else {
    const record = {
      kpnumber: kpNo,
      stage: stage,
      operatorname: operatorName || "",
      shift: shift || "",
      starttime: startTime || "",
      endtime: endTime || "",
      status: status || "Pending",
      activetimems: activeTimeMs || 0,
      holdhistory: holdHistoryObj ? (typeof holdHistoryObj === "string" ? holdHistoryObj : JSON.stringify(holdHistoryObj)) : "[]"
    };

    const newRow = headers.map(h => {
      const val = resolveFieldValue_(h, record);
      return val !== undefined ? val : "";
    });

    sheet.appendRow(newRow);
  }
}

function updateJobsMaster_(kpNo, updatesObj) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName("Jobs_Master");
  if (!sheet) throw new Error("Jobs_Master sheet not found");

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(cleanHeader_);
  const rowIndex = findRowInSheet_(sheet, "kpnumber", kpNo);

  if (rowIndex === -1) throw new Error("Job " + kpNo + " not found in Jobs_Master");

  // Automatically inject last updated time
  updatesObj["lastupdated"] = new Date().toISOString();

  const range = sheet.getRange(rowIndex, 1, 1, headers.length);
  const rowValues = range.getValues()[0];
  headers.forEach((h, index) => {
    const val = resolveFieldValue_(h, updatesObj);
    if (val !== undefined) {
      rowValues[index] = val;
    }
  });
  range.setValues([rowValues]);
}

function createJobInMaster_(jobData) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName("Jobs_Master");
  if (!sheet) throw new Error("Jobs_Master sheet not found");

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(cleanHeader_);
  const existsIndex = findRowInSheet_(sheet, "kpnumber", jobData.kpnumber || jobData.kpNo || jobData.kpNumber);
  if (existsIndex !== -1) throw new Error("Job with KP Number " + (jobData.kpnumber || jobData.kpNo || jobData.kpNumber) + " already exists");

  // Auto-inject metadata fields
  jobData["createddate"] = jobData.inspectiondate || new Date().toISOString();
  jobData["createdby"] = jobData.createdby || "System";
  jobData["lastupdated"] = new Date().toISOString();

  const newRow = headers.map(h => {
    const val = resolveFieldValue_(h, jobData);
    return val !== undefined ? val : "";
  });

  sheet.appendRow(newRow);
}

function addMaterialConsumption_(kpNo, stage, materialName, type, batch, unit, plannedQty, actualQty, operatorName) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName("Material_Consumption");
  if (!sheet) throw new Error("Material_Consumption sheet not found");

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(cleanHeader_);

  let rowIndex = -1;
  const data = sheet.getDataRange().getValues();
  if (data.length > 1) {
    let kpCol = -1;
    let stageCol = -1;
    let nameCol = -1;

    headers.forEach((h, idx) => {
      if (matchesField_(h, "kpnumber")) kpCol = idx;
      if (matchesField_(h, "stage")) stageCol = idx;
      if (matchesField_(h, "materialname")) nameCol = idx;
    });

    if (kpCol !== -1 && stageCol !== -1 && nameCol !== -1) {
      for (let i = 1; i < data.length; i++) {
        if (
          String(data[i][kpCol]).trim() === String(kpNo).trim() &&
          String(data[i][stageCol]).trim() === String(stage).trim() &&
          String(data[i][nameCol]).trim() === String(materialName).trim()
        ) {
          rowIndex = i + 1;
          break;
        }
      }
    }
  }

  const record = {
    kpnumber: kpNo,
    stage: stage,
    materialname: materialName,
    type: type || "",
    batch: batch || "",
    unit: unit || "",
    plannedqty: plannedQty || 0,
    actualqty: actualQty || 0,
    operatorname: operatorName || "",
    timestamp: new Date().toISOString()
  };

  if (rowIndex !== -1) {
    const range = sheet.getRange(rowIndex, 1, 1, headers.length);
    const rowValues = range.getValues()[0];
    headers.forEach((h, index) => {
      if (matchesField_(h, "actualqty")) {
        rowValues[index] = actualQty;
      } else if (matchesField_(h, "batch")) {
        rowValues[index] = batch;
      } else if (cleanHeader_(h) === "operator" || cleanHeader_(h) === "operatorname") {
        if (operatorName) rowValues[index] = operatorName;
      } else if (cleanHeader_(h) === "timestamp" || cleanHeader_(h) === "time") {
        rowValues[index] = new Date().toISOString();
      }
    });
    range.setValues([rowValues]);
  } else {
    const newRow = headers.map(h => {
      const val = resolveFieldValue_(h, record);
      return val !== undefined ? val : "";
    });
    sheet.appendRow(newRow);
  }
}

function logAudit_(user, department, kpNumber, action, details) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName("Audit_Log");
  if (!sheet) return;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(cleanHeader_);

  const rowObj = {
    timestamp: new Date().toISOString(),
    user: user || "System",
    department: department || "",
    kpnumber: kpNumber || "",
    action: action || "",
    details: details || ""
  };

  const newRow = headers.map(h => {
    const val = resolveFieldValue_(h, rowObj);
    return val !== undefined ? val : "";
  });

  sheet.appendRow(newRow);
}

function resolveFieldValue_(cleanH, dataObj) {
  if (matchesField_(cleanH, "kpnumber")) {
    const keys = ["kpnumber", "kpno", "jobid", "id", "kpNo", "kpNumber"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "partname")) {
    const keys = ["partname", "part", "jcnumber", "jcno", "partName"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "customer")) {
    const keys = ["customer", "customername", "customerName"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "quantity")) {
    const keys = ["quantity", "qty"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "processtype")) {
    const keys = ["processtype", "process", "type", "processType"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "priority")) {
    return dataObj.priority;
  }
  if (matchesField_(cleanH, "inspectiondate")) {
    return dataObj.inspectiondate !== undefined ? dataObj.inspectiondate : dataObj.inspectionDate;
  }
  if (matchesField_(cleanH, "receiveddate")) {
    return dataObj.receiveddate !== undefined ? dataObj.receiveddate : dataObj.receivedDate;
  }
  if (matchesField_(cleanH, "stage")) {
    const keys = ["currentdepartment", "currentstage", "stage", "department", "currentDepartment", "nextStage"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "status")) {
    return dataObj.status;
  }
  if (matchesField_(cleanH, "operatorname")) {
    const keys = ["operatorname", "operator", "operatorName", "user", "username"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "shift")) {
    return dataObj.shift;
  }
  if (matchesField_(cleanH, "starttime")) {
    const keys = ["starttime", "start", "startTime", "timestamp", "time"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "endtime")) {
    const keys = ["endtime", "end", "endTime"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "activetimems")) {
    const keys = ["activetimems", "durationms", "duration", "activetime", "activeTimeMs"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "holdhistory")) {
    return dataObj.holdhistory !== undefined ? dataObj.holdhistory : (dataObj.holdHistoryObj !== undefined ? dataObj.holdHistoryObj : dataObj.holdHistory);
  }
  if (matchesField_(cleanH, "materialname")) {
    return dataObj.materialname !== undefined ? dataObj.materialname : (dataObj.materialName !== undefined ? dataObj.materialName : dataObj.name);
  }
  if (matchesField_(cleanH, "materialtype")) {
    return dataObj.materialtype !== undefined ? dataObj.materialtype : (dataObj.materialType !== undefined ? dataObj.materialType : dataObj.type);
  }
  if (matchesField_(cleanH, "batch")) {
    return dataObj.batch !== undefined ? dataObj.batch : dataObj.batchNo;
  }
  if (matchesField_(cleanH, "unit")) {
    return dataObj.unit;
  }
  if (matchesField_(cleanH, "plannedqty")) {
    return dataObj.plannedqty !== undefined ? dataObj.plannedqty : (dataObj.plannedQty !== undefined ? dataObj.plannedQty : dataObj.planned);
  }
  if (matchesField_(cleanH, "actualqty")) {
    return dataObj.actualqty !== undefined ? dataObj.actualqty : (dataObj.actualQty !== undefined ? dataObj.actualQty : dataObj.actual);
  }
  if (matchesField_(cleanH, "details")) {
    const keys = ["details", "notes", "remark", "notes"];
    for (let k of keys) {
      if (dataObj[k] !== undefined) return dataObj[k];
    }
    return undefined;
  }
  if (matchesField_(cleanH, "action")) {
    return dataObj.action;
  }
  if (matchesField_(cleanH, "createdby")) {
    return dataObj.createdby !== undefined ? dataObj.createdby : dataObj.createdBy;
  }
  if (matchesField_(cleanH, "lastupdated")) {
    return dataObj.lastupdated !== undefined ? dataObj.lastupdated : dataObj.lastUpdated;
  }
  return dataObj[cleanH] !== undefined ? dataObj[cleanH] : dataObj[cleanH.toUpperCase()];
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function parseRequestData_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  return JSON.parse(e.postData.contents);
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getInspectionKPsHandler_(e) {
  try {
    const operator = (e && e.parameter && e.parameter.operator) ? String(e.parameter.operator).trim().toUpperCase() : "";
    
    // Check if we have the master records in cache
    const cache = CacheService.getScriptCache();
    let recordsJson = cache.get("INSPECTION_MASTER_RECORDS");
    let records = [];
    
    if (recordsJson) {
      records = JSON.parse(recordsJson);
    } else {
      records = fetchAndCacheInspectionMasterRecords_();
    }
    
    const filteredRecords = records.filter(r => {
      // Exclude delivered records (case-insensitive)
      const isDelivered = r.status && String(r.status).trim().toLowerCase() === 'delivered';
      if (operator) {
        if (isDelivered) return false;
        // Must match either assignedFirst or assignedSecond (trimmed and case-insensitive)
        const firstOp = String(r.assignedFirst || "").trim().toUpperCase();
        const secondOp = String(r.assignedSecond || "").trim().toUpperCase();
        return (firstOp === operator || secondOp === operator);
      }
      
      // Admin user sees everything
      return true;
    });
    
    return jsonResponse_(filteredRecords);
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err) });
  }
}

function getInspectionRecordHandler_(e) {
  try {
    const kpNo = (e && e.parameter && e.parameter.kpNo) ? String(e.parameter.kpNo).trim().toUpperCase() : "";
    const operator = (e && e.parameter && e.parameter.operator) ? String(e.parameter.operator).trim().toUpperCase() : "";
    if (!kpNo) return jsonResponse_({ success: false, error: "Missing kpNo parameter" });
    
    // Check if we have the master records in cache
    const cache = CacheService.getScriptCache();
    let recordsJson = cache.get("INSPECTION_MASTER_RECORDS");
    let records = [];
    
    if (recordsJson) {
      records = JSON.parse(recordsJson);
    } else {
      records = fetchAndCacheInspectionMasterRecords_();
    }
    
    const record = records.find(r => r.kpNo.toUpperCase() === kpNo);
    if (!record) {
      return jsonResponse_({ success: false, error: "KP Number " + kpNo + " not found" });
    }
    
    // Security check: if operator parameter is provided, verify they are assigned
    const firstOp = String(record.assignedFirst || "").trim().toUpperCase();
    const secondOp = String(record.assignedSecond || "").trim().toUpperCase();
    const isDelivered = String(record.status || "").trim().toLowerCase() === 'delivered';
    
    if (operator) {
      if (isDelivered) {
        return jsonResponse_({ success: false, error: "Unauthorized access: Job has been delivered" });
      }
      if (firstOp !== operator && secondOp !== operator) {
        return jsonResponse_({ success: false, error: "Unauthorized access: You are not assigned to this job" });
      }
    }
    
    return jsonResponse_(record);
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err) });
  }
}

function fetchAndCacheInspectionMasterRecords_() {
  const ss = SpreadsheetApp.openById("1ip55xEk5rtdqqhCeJ8Hx0IT6aBfnO_0eFIEKh3a7cYg");
  const sheet = ss.getSheetByName("FMS") || ss.getSheets()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  
  // 1. Read first 30 rows to locate headers dynamically
  const scanRows = Math.min(lastRow, 30);
  const scanData = sheet.getRange(1, 1, scanRows, Math.min(sheet.getLastColumn(), 41)).getValues();
  
  let headerRowIdx = -1;
  for (let i = 0; i < scanData.length; i++) {
    if (scanData[i].some(cell => {
      const c = String(cell).trim().toLowerCase();
      return c === "customer" || c === "customer name" || c === "kp no" || c === "kp no.";
    })) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) headerRowIdx = 4; // FMS default header row index 4 (row 5)
  
  const headers = scanData[headerRowIdx].map(cleanHeader_);
  
  // Find column indices (1-based)
  let kpCol = 20; // fallback T
  let custCol = 6; // fallback F
  let partCol = 9; // fallback I
  let qtyCol = 12; // fallback L
  let statusCol = 3; // fallback C
  let assignedFirstCol = 22; // fallback V
  let timestampCol = 1; // fallback A
  
  headers.forEach((h, idx) => {
    const cleaned = cleanHeader_(h);
    const colNum = idx + 1;
    if (matchesField_(h, "kpnumber")) kpCol = colNum;
    else if (matchesField_(h, "customer")) custCol = colNum;
    else if (matchesField_(h, "partname")) partCol = colNum;
    else if (matchesField_(h, "quantity")) qtyCol = colNum;
    else if (cleaned === "statuspo") {
      // ONLY use the "status (PO)" column (Column C) — never use the generic "Status" column (Column Y)
      statusCol = colNum;
    }
    else if (cleaned.indexOf("first") !== -1 || cleaned.indexOf("second") !== -1 || cleaned.indexOf("firstsecond") !== -1 || cleaned.indexOf("assignedfirst") !== -1 || cleaned.indexOf("assingedfirstsecond") !== -1) {
      assignedFirstCol = colNum;
    }
    else if (cleaned === "timestamp" || cleaned === "date") {
      timestampCol = colNum;
    }
  });
  
  // 2. Find actual last row by scanning the KP column values
  let actualLastRow = headerRowIdx + 1;
  const kpValues = sheet.getRange(1, kpCol, lastRow, 1).getValues();
  for (let i = kpValues.length - 1; i >= headerRowIdx; i--) {
    const val = String(kpValues[i][0]).trim();
    if (val && /^kp-/i.test(val)) {
      actualLastRow = i + 1;
      break;
    }
  }
  
  // 3. Fetch each required column separately up to actualLastRow
  const dataRowsCount = actualLastRow - (headerRowIdx + 1);
  if (dataRowsCount <= 0) return [];
  
  const startRow = headerRowIdx + 2; // data starts 1 row after header
  
  const kps = sheet.getRange(startRow, kpCol, dataRowsCount, 1).getValues();
  const custs = sheet.getRange(startRow, custCol, dataRowsCount, 1).getValues();
  const parts = sheet.getRange(startRow, partCol, dataRowsCount, 1).getValues();
  const qtys = sheet.getRange(startRow, qtyCol, dataRowsCount, 1).getValues();
  const stats = sheet.getRange(startRow, statusCol, dataRowsCount, 1).getValues();
  const firstOps = sheet.getRange(startRow, assignedFirstCol, dataRowsCount, 1).getValues();
  const timestamps = sheet.getRange(startRow, timestampCol, dataRowsCount, 1).getValues();
  
  // 4. Assemble the records
  const records = [];
  for (let i = 0; i < dataRowsCount; i++) {
    const kp = String(kps[i][0]).trim();
    if (!kp || !/^kp-/i.test(kp)) continue;
    
    records.push({
      kpNo: kp,
      customer: String(custs[i][0]).trim(),
      partName: String(parts[i][0]).trim(),
      quantity: String(qtys[i][0]).trim(),
      status: String(stats[i][0]).trim(),
      assignedFirst: String(firstOps[i][0]).trim(),
      assignedSecond: "", // only single operator column exists in FMS sheet
      timestamp: String(timestamps[i][0]).trim(),
      rowIndex: startRow + i
    });
  }
  
  // Cache the records for 6 hours
  const jsonStr = JSON.stringify(records);
  if (jsonStr.length < 100000) {
    try {
      CacheService.getScriptCache().put("INSPECTION_MASTER_RECORDS", jsonStr, 21600); // Cache for 6 hours
    } catch (e) {
      console.warn("Failed to write to Apps Script cache:", e);
    }
  }
  
  return records;
}


