function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action).trim() : "";
    const process = (e && e.parameter && e.parameter.process) ? String(e.parameter.process).trim() : "";
    
    // Fallback for old masking iframe
    if (process.toUpperCase() === "MASKING") {
      return getMaskingQueue_(e);
    }
    
    if (action === "getJobs") {
      return getJobsHandler_(e);
    } else if (action === "getJobByKP") {
      return getJobByKPHandler_(e);
    } else if (action === "getMaterialConsumption") {
      return getMaterialConsumptionHandler_(e);
    } else if (action === "getDashboardStats") {
      return getDashboardStatsHandler_(e);
    } else if (action === "getOperators" || action === "getUsers") {
      return getOperatorsHandler_(e);
    } else if (action === "getMaterials" || action === "getMasterMaterials") {
      return getMaterialsHandler_(e);
    } else if (action === "getAuditLogs") {
      return getAuditLogsHandler_(e);
    }
    
    // Fallback for standard process lookup
    return handleGet_(e);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: String(error) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function handleGet_(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const process = (e && e.parameter && e.parameter.process)
    ? String(e.parameter.process).trim()
    : "";

  Logger.log("doGet called, process: " + process);

  if (process.toUpperCase() === "MASKING") {
    Logger.log("Routing to getMaskingQueue_");
    return getMaskingQueue_(e);
  }

  let sheet = process
    ? ss.getSheetByName("NextProcessQueue")
    : ss.getSheetByName("Jobs");

  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: "Sheet not found" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const data = sheet.getDataRange().getValues();
  if (data.length === 0) {
    return ContentService
      .createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const headers = data.shift();
  let result = data
    .filter(row => row.some(cell => String(cell ?? "").trim() !== ""))
    .map(row => {
      let obj = {};
      headers.forEach((header, index) => {
        obj[String(header).trim()] = row[index];
      });
      if (!process) {
        const importedQty = obj.Qty !== undefined ? obj.Qty : "";
        const pendingQty = obj.PendingQty !== undefined ? obj.PendingQty : "";
        obj.displayQty = pendingQty !== "" && pendingQty !== null ? pendingQty : importedQty;
      }
      return obj;
    });

  if (process) {
    result = result.filter(row =>
      String(row.nextProcess || "").trim().toUpperCase() === process.toUpperCase() &&
      String(row.Status || "").trim().toUpperCase() !== "COMPLETED"
    );
  } else {
    result = result.filter(row => {
      const status = String(row.Status || "").trim().toUpperCase();
      return status !== "REMOVED" && status !== "COMPLETED";
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const data = parseRequestData_(e);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const materialLocationSheet = ss.getSheetByName("MaterialLocationLog");
    const sprayingLogSheet = ss.getSheetByName("spraying_log");
    const sealingLogSheet = ss.getSheetByName("sealing_log");
    const grindingLogSheet = ss.getSheetByName("grinding_log");
    const jobsSheet = ss.getSheetByName("Jobs");
    const nextProcessSheet = ss.getSheetByName("NextProcessQueue");
    const oeeSheet = ss.getSheetByName("OEELog");

    if (!data.type) {
      return jsonResponse_({ success: false, error: "Missing request type" });
    }

    // ── START CYCLE ───────────────────────────────────────────────────────────
    if (data.type === "START_CYCLE") {
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

    // ── PAUSE_CYCLE ───────────────────────────────────────────────────────────
    if (data.type === "PAUSE_CYCLE") {
      updateProcessHistory_(data.kpNo, data.stage, data.operatorName, undefined, undefined, new Date().toISOString(), "Hold", data.activeTimeMs, data.holdHistory || []);
      updateJobsMaster_(data.kpNo, {
        status: "Hold"
      });
      logAudit_(data.operatorName, data.stage, data.kpNo, "Cycle Paused", "Put on Hold (Reason: " + (data.holdReason || "N/A") + ")");
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "PAUSE_CYCLE" });
    }

    // ── RESUME_CYCLE ──────────────────────────────────────────────────────────
    if (data.type === "RESUME_CYCLE") {
      updateProcessHistory_(data.kpNo, data.stage, data.operatorName, undefined, new Date().toISOString(), undefined, "In Progress", undefined, data.holdHistory || []);
      updateJobsMaster_(data.kpNo, {
        status: "In Progress"
      });
      logAudit_(data.operatorName, data.stage, data.kpNo, "Cycle Resumed", "Job returned to active state");
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "RESUME_CYCLE" });
    }

    // ── END_CYCLE ─────────────────────────────────────────────────────────────
    if (data.type === "END_CYCLE") {
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

    // ── ADD_MATERIAL_CONSUMPTION ──────────────────────────────────────────────
    if (data.type === "ADD_MATERIAL_CONSUMPTION") {
      addMaterialConsumption_(data.kpNo, data.stage, data.materialName, data.materialType, data.batch, data.unit, data.plannedQty, data.actualQty);
      logAudit_(data.operatorName, data.stage, data.kpNo, "Material Added", "Added material " + data.materialName + " (Batch: " + (data.batch || "N/A") + ")");
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "ADD_MATERIAL_CONSUMPTION" });
    }

    // ── DELETE_MATERIAL_CONSUMPTION ───────────────────────────────────────────
    if (data.type === "DELETE_MATERIAL_CONSUMPTION") {
      const mcSheet = ss.getSheetByName("Material_Consumption");
      if (mcSheet) {
        const mcHeaders = mcSheet.getRange(1, 1, 1, mcSheet.getLastColumn()).getValues()[0].map(cleanHeader_);
        const kpCol = mcHeaders.indexOf("kpnumber");
        const stageCol = mcHeaders.indexOf("stage");
        const nameCol = mcHeaders.indexOf("materialname");
        const mcDataRange = mcSheet.getDataRange().getValues();
        
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
      logAudit_(data.operatorName, data.stage, data.kpNo, "Material Removed", "Removed material " + data.materialName);
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "DELETE_MATERIAL_CONSUMPTION" });
    }


    // ── CREATE_AUDIT_LOG ──────────────────────────────────────────────────────
    if (data.type === "CREATE_AUDIT_LOG") {
      logAudit_(data.user, data.department, data.kpNo, data.action, data.details);
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "CREATE_AUDIT_LOG" });
    }

    // ── CREATE_JOB ────────────────────────────────────────────────────────────
    if (data.type === "CREATE_JOB") {
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

    // ── SAVE MASKING JOB (Legacy & Sync) ──────────────────────────────────────
    if (data.type === "SAVE_MASKING_JOB") {
      const dedupeKey = buildDedupeKey_("SAVE_MASKING_JOB", data);

      if (isDuplicateRequest_(dedupeKey, 120)) {
        return jsonResponse_({
          success: true,
          mode: "SAVE_MASKING_JOB",
          duplicate: true,
          message: "Duplicate SAVE_MASKING_JOB request ignored"
        });
      }

      const response = saveMaskingJob_(data);

      try {
        const next = data.nextProcess || "Spraying";
        updateProcessHistory_(data.kpNo, "Masking", data.operatorName || "Masking Operator", "", data.startTime, data.endTime, "Completed", 0, []);
        updateJobsMaster_(data.kpNo, {
          currentdepartment: next,
          status: "Pending",
          operatorname: "",
          shift: ""
        });
        logAudit_(data.operatorName || "Masking Operator", "Masking", data.kpNo, "Cycle Completed", "Completed masking, routed to " + next);
      } catch (err) {
        Logger.log("New database sync in SAVE_MASKING_JOB failed: " + err.toString());
      }

      markRequestProcessed_(dedupeKey);
      SpreadsheetApp.flush();

      return response;
    }

    // ── MATERIAL LOCATION (Legacy) ────────────────────────────────────────────
    if (data.type === "MATERIAL_LOCATION") {
      if (materialLocationSheet) {
        materialLocationSheet.appendRow([
          new Date(),
          data.jobId || "",
          data.part || "",
          data.qty || "",
          data.location || "",
          data.customerName || ""
        ]);
      }
      SpreadsheetApp.flush();
      return jsonResponse_({ success: true, mode: "MATERIAL_LOCATION" });
    }

    // ── DELETE JOB QUEUE (Legacy) ─────────────────────────────────────────────
    if (data.type === "DELETE_JOB_QUEUE") {
      if (jobsSheet) {
        const jobsData = jobsSheet.getDataRange().getValues();
        for (let i = 1; i < jobsData.length; i++) {
          if (String(jobsData[i][0]) === String(data.jobId)) {
            jobsSheet.getRange(i + 1, 5).setValue("REMOVED");
            SpreadsheetApp.flush();
            return jsonResponse_({ success: true, mode: "DELETE_JOB_QUEUE" });
          }
        }
      }
      return jsonResponse_({
        success: false,
        mode: "DELETE_JOB_QUEUE",
        error: "Job ID not found in Jobs sheet"
      });
    }

    // ── SAVE SPRAYING JOB (Legacy & Sync) ─────────────────────────────────────
    if (data.type === "SAVE_SPRAYING_JOB") {
      const dedupeKey = buildDedupeKey_("SAVE_SPRAYING_JOB", data);

      if (isDuplicateRequest_(dedupeKey, 120)) {
        return jsonResponse_({
          success: true,
          mode: "SAVE_SPRAYING_JOB",
          duplicate: true,
          message: "Duplicate SAVE_SPRAYING_JOB request ignored"
        });
      }

      if (sprayingLogSheet) {
        sprayingLogSheet.appendRow([
          new Date(),
          data.batchId || "",
          data.jobId || "",
          data.part || "",
          data.customerName || "",
          data.qty || "",
          data.processedQty || "",
          data.nextProcess || "",
          data.totalPasses || "",
          data.finalTemp || "",
          data.finalThickness || "",
          data.finalSize || "",
          data.powderConsumed || "",
          data.location || "",
          data.cycleSeconds || "",
          data.shiftOEE || ""
        ]);
      }

      if (oeeSheet) {
        oeeSheet.appendRow([
          new Date(),
          "Spraying",
          data.jobId || "",
          data.noWorkTime !== undefined ? data.noWorkTime : "",
          data.operatorIdleTime || "",
          data.activeWorkTime || "",
          data.shiftOEE || ""
        ]);
      }

      if (data.nextProcess && nextProcessSheet) {
        if (!nextProcessEntryExists_(nextProcessSheet, data)) {
          nextProcessSheet.appendRow([
            new Date(),
            data.batchId || "",
            data.jobId || "",
            data.part || "",
            data.customerName || "",
            data.processedQty || "",
            data.nextProcess || "",
            "PENDING"
          ]);
        }
      }

      if (jobsSheet) {
        updateJobQtyAndStatus(jobsSheet, data.jobId, data.processedQty);
      }

      // Sync with unified database
      try {
        const next = data.nextProcess || "Grinding";
        const activeTimeMs = (Number(data.cycleSeconds) || 0) * 1000;
        updateProcessHistory_(data.jobId, "Spraying", data.operatorName || "Spraying Operator", "", undefined, new Date().toISOString(), "Completed", activeTimeMs, []);
        updateJobsMaster_(data.jobId, {
          currentdepartment: next,
          status: "Pending",
          operatorname: "",
          shift: ""
        });
        if (data.powderConsumed) {
          addMaterialConsumption_(data.jobId, "Spraying", "Powder", "Powder", "", "KG", 0, Number(data.powderConsumed) || 0);
        }
        logAudit_(data.operatorName || "Spraying Operator", "Spraying", data.jobId, "Cycle Completed", "Completed spraying, routed to " + next);
      } catch (err) {
        Logger.log("New database sync in SAVE_SPRAYING_JOB failed: " + err.toString());
      }

      markRequestProcessed_(dedupeKey);
      SpreadsheetApp.flush();

      return jsonResponse_({ success: true, mode: "SAVE_SPRAYING_JOB" });
    }

    // ── SAVE SEALING JOB (Legacy) ─────────────────────────────────────────────
    if (data.type === "SAVE_SEALING_JOB") {
      const dedupeKey = buildDedupeKey_("SAVE_SEALING_JOB", data);

      if (isDuplicateRequest_(dedupeKey, 120)) {
        return jsonResponse_({
          success: true,
          mode: "SAVE_SEALING_JOB",
          duplicate: true,
          message: "Duplicate SAVE_SEALING_JOB request ignored"
        });
      }

      if (sealingLogSheet) {
        sealingLogSheet.appendRow([
          new Date(),
          data.jobId || "",
          data.part || "",
          data.customerName || "",
          data.qty || "",
          data.processedQty || "",
          data.location || "",
          data.totalPasses || "",
          data.dia || "",
          data.liquidUsedName || "",
          data.liquidUsedQty || "",
          data.cycleSeconds || "",
          data.shiftOEE || "",
          data.noWorkTime || "",
          data.operatorIdleTime || "",
          data.activeWorkTime || ""
        ]);
      }

      if (oeeSheet) {
        oeeSheet.appendRow([
          new Date(),
          "Sealing",
          data.jobId || "",
          data.noWorkTime || "",
          data.operatorIdleTime || "",
          data.activeWorkTime || "",
          data.shiftOEE || ""
        ]);
      }

      if (jobsSheet) {
        updateJobQtyAndStatus(jobsSheet, data.jobId, data.processedQty);
      }
      if (nextProcessSheet) {
        updateNextProcessQueueStatus(nextProcessSheet, data.jobId, "COMPLETED");
      }
      markRequestProcessed_(dedupeKey);
      SpreadsheetApp.flush();

      return jsonResponse_({ success: true, mode: "SAVE_SEALING_JOB" });
    }

    // ── SAVE GRINDING JOB (Legacy) ────────────────────────────────────────────
    if (data.type === "SAVE_GRINDING_JOB") {
      if (!grindingLogSheet) {
        return jsonResponse_({
          success: false,
          error: "grinding_log sheet not found"
        });
      }

      const dedupeKey = buildDedupeKey_("SAVE_GRINDING_JOB", data);

      if (isDuplicateRequest_(dedupeKey, 120)) {
        return jsonResponse_({
          success: true,
          mode: "SAVE_GRINDING_JOB",
          duplicate: true,
          message: "Duplicate SAVE_GRINDING_JOB request ignored"
        });
      }

      grindingLogSheet.appendRow([
        new Date(),
        data.batchId || "",
        data.jobId || "",
        data.part || "",
        data.customerName || "",
        data.qty || "",
        data.processedQty || "",
        data.location || "",
        data.machineName || "",
        data.process || "",
        data.workHeadRPM || "",
        data.wheelType || "",
        data.diameter || "",
        data.runOutReading || "",
        data.tolerant || "",
        data.grindingLength || "",
        data.micrometerNo || "",
        data.mandrelNo || "",
        data.coolantQty || "",
        data.operatorName || "",
        data.cycleSeconds || "",
        data.shiftOEE || "",
        data.noWorkTime || "",
        data.operatorIdleTime || "",
        data.activeWorkTime || "",
        data.remarks || ""
      ]);

      if (oeeSheet) {
        oeeSheet.appendRow([
          new Date(),
          "Grinding",
          data.jobId || "",
          data.noWorkTime || "",
          data.operatorIdleTime || "",
          data.activeWorkTime || "",
          data.shiftOEE || ""
        ]);
      }

      if (jobsSheet) {
        updateJobQtyAndStatus(jobsSheet, data.jobId, data.processedQty);
      }
      if (nextProcessSheet) {
        updateNextProcessQueueStatus(nextProcessSheet, data.jobId, "COMPLETED");
      }
      markRequestProcessed_(dedupeKey);
      SpreadsheetApp.flush();

      return jsonResponse_({ success: true, mode: "SAVE_GRINDING_JOB" });
    }

    return jsonResponse_({ success: false, error: "Invalid request type: " + data.type });

  } catch (error) {
    return jsonResponse_({ success: false, error: String(error) });
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {}
  }
}

// ── GET HANDLERS ──────────────────────────────────────────────────────────────

function getSheetDataJson_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
      if (cleanKey === "kpnumber" || cleanKey === "kpno" || cleanKey === "jobid" || cleanKey === "id") {
        kpNumber = String(val);
      } else if (cleanKey === "partname" || cleanKey === "part" || cleanKey === "jcnumber" || cleanKey === "jcno") {
        partName = String(val);
      } else if (cleanKey === "customer" || cleanKey === "customername") {
        customer = String(val);
      } else if (cleanKey === "quantity" || cleanKey === "qty") {
        quantity = Number(val) || 0;
      } else if (cleanKey === "processtype" || cleanKey === "process" || cleanKey === "type") {
        processType = String(val);
      } else if (cleanKey === "priority") {
        priority = String(val);
      } else if (cleanKey === "inspectiondate") {
        inspectionDate = formatDateValue_(val);
      } else if (cleanKey === "receiveddate") {
        receivedDate = formatDateValue_(val);
      } else if (cleanKey === "currentdepartment" || cleanKey === "currentstage" || cleanKey === "stage" || cleanKey === "department") {
        currentDepartment = String(val);
      } else if (cleanKey === "status" || cleanKey === "globalstatus") {
        status = String(val);
      } else if (cleanKey === "operatorname" || cleanKey === "operator") {
        operatorName = String(val);
      } else if (cleanKey === "shift") {
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
        if (cleanHeader_(k) === "kpnumber" || cleanHeader_(k) === "kpno") {
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
        if (ck === "stage" || ck === "process" || ck === "department") {
          stage = String(val);
        } else if (ck === "status") {
          hStatus = String(val);
        } else if (ck === "operatorname" || ck === "operator") {
          hOp = String(val);
        } else if (ck === "shift") {
          hShift = String(val);
        } else if (ck === "starttime" || ck === "start") {
          hStart = val ? new Date(val).toISOString() : null;
        } else if (ck === "endtime" || ck === "end") {
          hEnd = val ? new Date(val).toISOString() : null;
        } else if (ck === "activetimems" || ck === "durationms" || ck === "activetime") {
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
        if (cleanHeader_(k) === "kpnumber" || cleanHeader_(k) === "kpno") {
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
        if (ck === "materialname" || ck === "name") {
          mName = String(val);
        } else if (ck === "type") {
          mType = String(val);
        } else if (ck === "batch" || ck === "batchno") {
          mBatch = String(val);
        } else if (ck === "unit") {
          mUnit = String(val);
        } else if (ck === "plannedqty" || ck === "planned") {
          mPlanned = Number(val) || 0;
        } else if (ck === "actualqty" || ck === "actual") {
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

  return jsonResponse_(mappedJobs);
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
        if (cleanHeader_(k) === "kpnumber" || cleanHeader_(k) === "kpno") {
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
      if (ck === "name" || ck === "materialname") name = String(val);
      else if (ck === "type") type = String(val);
      else if (ck === "batch" || ck === "batchno") batch = String(val);
      else if (ck === "unit") unit = String(val);
      else if (ck === "plannedqty") plannedQty = Number(val) || 0;
      else if (ck === "actualqty") actualQty = Number(val) || 0;
      else if (ck === "id" || ck === "materialid") id = String(val);
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

function findRowInSheet_(sheet, colName1, val1, colName2, val2) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return -1;
  const headers = data[0].map(cleanHeader_);
  
  function matchesColName(h, field) {
    const cf = cleanHeader_(field);
    if (cf === "kpnumber" || cf === "kpno") {
      return ["kpnumber", "kpno", "jobid", "id", "kp", "jobcardno", "jobcardnumber"].indexOf(h) !== -1;
    }
    if (cf === "stage" || cf === "process" || cf === "department") {
      return ["stage", "process", "department", "currentdepartment", "currentprocess", "currentstage"].indexOf(h) !== -1;
    }
    return h === cf;
  }

  const colIndices1 = [];
  const colIndices2 = [];
  
  for (let idx = 0; idx < headers.length; idx++) {
    const h = headers[idx];
    if (matchesColName(h, colName1)) {
      colIndices1.push(idx);
    }
    if (colName2 && matchesColName(h, colName2)) {
      colIndices2.push(idx);
    }
  }

  if (colIndices1.length === 0) return -1;

  const targetVal1 = String(val1).trim();
  const targetVal2 = colName2 ? String(val2).trim() : null;

  for (let i = 1; i < data.length; i++) {
    const match1 = colIndices1.some(colIdx => String(data[i][colIdx]).trim() === targetVal1);
    if (match1) {
      if (!colName2) {
        return i + 1;
      }
      const match2 = colIndices2.some(colIdx => String(data[i][colIdx]).trim() === targetVal2);
      if (match2) {
        return i + 1;
      }
    }
  }
  return -1;
}

function updateProcessHistory_(kpNo, stage, operatorName, shift, startTime, endTime, status, activeTimeMs, holdHistoryObj) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Process_History");
  if (!sheet) throw new Error("Process_History sheet not found");

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(cleanHeader_);
  const rowIndex = findRowInSheet_(sheet, "kpnumber", kpNo, "stage", stage);

  const record = {};
  if (operatorName !== undefined) record["operatorname"] = operatorName;
  if (shift !== undefined) record["shift"] = shift;
  if (startTime !== undefined) record["starttime"] = startTime;
  if (endTime !== undefined) record["endtime"] = endTime;
  if (status !== undefined) record["status"] = status;
  if (activeTimeMs !== undefined) record["activetimems"] = activeTimeMs;
  if (holdHistoryObj !== undefined) record["holdhistory"] = JSON.stringify(holdHistoryObj);

  if (rowIndex !== -1) {
    const range = sheet.getRange(rowIndex, 1, 1, headers.length);
    const rowValues = range.getValues()[0];
    for (let key in record) {
      const colIndex = headers.indexOf(cleanHeader_(key));
      if (colIndex !== -1) {
        rowValues[colIndex] = record[key];
      }
    }
    range.setValues([rowValues]);
  } else {
    const newRecord = {
      kpnumber: kpNo,
      stage: stage,
      operatorname: operatorName || "",
      shift: shift || "",
      starttime: startTime || "",
      endtime: endTime || "",
      status: status || "Pending",
      activetimems: activeTimeMs || 0,
      holdhistory: holdHistoryObj ? JSON.stringify(holdHistoryObj) : "[]"
    };

    const newRow = headers.map(h => {
      return newRecord[h] !== undefined ? newRecord[h] : "";
    });

    sheet.appendRow(newRow);
  }
}

function updateJobsMaster_(kpNo, updatesObj) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Jobs_Master");
  if (!sheet) throw new Error("Jobs_Master sheet not found");

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(cleanHeader_);
  const rowIndex = findRowInSheet_(sheet, "kpnumber", kpNo);

  if (rowIndex === -1) throw new Error("Job " + kpNo + " not found in Jobs_Master");

  const range = sheet.getRange(rowIndex, 1, 1, headers.length);
  const rowValues = range.getValues()[0];
  for (let key in updatesObj) {
    const colIndex = headers.indexOf(cleanHeader_(key));
    if (colIndex !== -1) {
      rowValues[colIndex] = updatesObj[key];
    }
  }
  range.setValues([rowValues]);
}

function createJobInMaster_(jobData) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Jobs_Master");
  if (!sheet) throw new Error("Jobs_Master sheet not found");

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(cleanHeader_);
  const existsIndex = findRowInSheet_(sheet, "kpnumber", jobData.kpnumber);
  if (existsIndex !== -1) throw new Error("Job with KP Number " + jobData.kpnumber + " already exists");

  const newRow = headers.map(h => {
    return jobData[h] !== undefined ? jobData[h] : "";
  });

  sheet.appendRow(newRow);
}

function addMaterialConsumption_(kpNo, stage, materialName, type, batch, unit, plannedQty, actualQty) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Material_Consumption");
  if (!sheet) throw new Error("Material_Consumption sheet not found");

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(cleanHeader_);

  let rowIndex = -1;
  const data = sheet.getDataRange().getValues();
  if (data.length > 1) {
    const kpCol = headers.indexOf("kpnumber");
    const stageCol = headers.indexOf("stage");
    const nameCol = headers.indexOf("materialname");

    for (let i = 1; i < data.length; i++) {
      if (
        String(data[i][kpCol]) === String(kpNo) &&
        String(data[i][stageCol]) === String(stage) &&
        String(data[i][nameCol]) === String(materialName)
      ) {
        rowIndex = i + 1;
        break;
      }
    }
  }

  if (rowIndex !== -1) {
    const range = sheet.getRange(rowIndex, 1, 1, headers.length);
    const rowValues = range.getValues()[0];
    const actualCol = headers.indexOf("actualqty");
    const batchCol = headers.indexOf("batch");
    if (actualCol >= 0) rowValues[actualCol] = actualQty;
    if (batchCol >= 0) rowValues[batchCol] = batch;
    range.setValues([rowValues]);
  } else {
    const record = {
      kpnumber: kpNo,
      stage: stage,
      materialname: materialName,
      type: type || "",
      batch: batch || "",
      unit: unit || "",
      plannedqty: plannedQty || 0,
      actualqty: actualQty || 0
    };

    const newRow = headers.map(h => {
      return record[h] !== undefined ? record[h] : "";
    });
    sheet.appendRow(newRow);
  }
}

function logAudit_(user, department, kpNumber, action, details) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
    return rowObj[h] !== undefined ? rowObj[h] : "";
  });

  sheet.appendRow(newRow);
}

// ── LEGACY MASKING FUNCTIONS ──────────────────────────────────────────────────

function getMaskingQueue_(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("Masking Job");

  if (!sh) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: "Sheet not found: Masking Job" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    return ContentService
      .createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const values = sh.getRange(2, 1, lastRow - 1, 17).getDisplayValues();

  const result = values
    .filter(row => {
      const kpNo = String(row[0] ?? "").trim();
      return kpNo !== "";
    })
    .map((row, idx) => ({
      rowIndex:              idx + 2,
      kpNo:                  String(row[0]  || "").trim(),
      jcNo:                  String(row[1]  || "").trim(),
      customerName:          String(row[2]  || "").trim(),
      materialName:          String(row[3]  || "").trim(),
      qty:                   row[4]  || 0,
      incomingName:          String(row[5]  || "").trim(),
      preCompletionDate:     row[6]  || "",
      productionPlannedDate: row[7]  || "",
      productionCompDate:    row[8]  || "",
      maskingStartDate:      row[9]  || "",
      status:                String(row[10] || "").trim(),
      maskingActualStart:    row[11] || "",
      maskingActualEnd:      row[12] || "",
      nextProcess:           String(row[13] || "").trim(),
      processQty:            row[14] || "",
      pendingQty:            row[15] || "",
      operatorName:          String(row[16] || "").trim(),
    }))
    .filter(row => {
      const status = row.status.toUpperCase();
      return status !== "DONE" && status !== "COMPLETED";
    });

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function saveMaskingJob_(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("Masking Job");

  if (!sh) {
    return jsonResponse_({ success: false, error: "Sheet not found: Masking Job" });
  }

  const row = Number(data.rowIndex);
  if (!row || row < 2) {
    return jsonResponse_({ success: false, error: "Invalid rowIndex" });
  }

  const totalQty  = Number(data.qty     || 0);
  const doerQty   = Number(data.doerQty || 0);
  const pendingQty = Math.max(totalQty - doerQty, 0);
  const finalStatus = pendingQty > 0 ? "PENDING" : "DONE";

  sh.getRange(row, 11, 1, 7).setValues([[
    finalStatus,
    data.startTime || "",
    data.endTime   || "",
    data.nextProcess || "",
    doerQty,
    pendingQty,
    data.operatorName || ""
  ]]);

  SpreadsheetApp.flush();

  return jsonResponse_({
    success: true,
    mode: "SAVE_MASKING_JOB",
    rowIndex: row,
    pendingQty,
    status: finalStatus
  });
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

function buildDedupeKey_(type, data) {
  if (data.requestId) {
    return "REQ_" + String(type) + "|" + String(data.requestId);
  }

  const qtyKey =
    data.processedQty !== undefined && data.processedQty !== null && data.processedQty !== ""
      ? data.processedQty
      : (data.doerQty !== undefined && data.doerQty !== null ? data.doerQty : "");

  const parts = [
    type || "",
    data.batchId || "",
    data.jobId || "",
    data.part || "",
    data.rowIndex || "",
    qtyKey,
    data.nextProcess || "",
    data.location || "",
    data.cycleSeconds || ""
  ];

  return "REQ_" + parts.map(String).join("|");
}

function isDuplicateRequest_(key, maxAgeSeconds) {
  const props = PropertiesService.getScriptProperties();
  const value = props.getProperty(key);

  if (!value) return false;

  const savedTime = Number(value) || 0;
  const now = Date.now();
  const ageSeconds = (now - savedTime) / 1000;

  if (ageSeconds <= maxAgeSeconds) {
    return true;
  }

  props.deleteProperty(key);
  return false;
}

function markRequestProcessed_(key) {
  PropertiesService.getScriptProperties().setProperty(key, String(Date.now()));
}

function nextProcessEntryExists_(nextProcessSheet, data) {
  const lastRow = nextProcessSheet.getLastRow();
  if (lastRow < 2) return false;

  const values = nextProcessSheet.getRange(2, 1, lastRow - 1, 8).getValues();

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const batchId = row[1];
    const jobId = row[2];
    const part = row[3];
    const processedQty = row[5];
    const nextProcess = row[6];
    const status = row[7];

    if (
      String(batchId) === String(data.batchId || "") &&
      String(jobId) === String(data.jobId || "") &&
      String(part) === String(data.part || "") &&
      String(processedQty) === String(data.processedQty || "") &&
      String(nextProcess) === String(data.nextProcess || "") &&
      String(status || "").toUpperCase() !== "COMPLETED"
    ) {
      return true;
    }
  }

  return false;
}

function updateJobQtyAndStatus(jobsSheet, jobId, processedQtyValue) {
  const jobsData = jobsSheet.getDataRange().getValues();

  for (let i = 1; i < jobsData.length; i++) {
    if (String(jobsData[i][0]) === String(jobId)) {
      const importedQty = Number(jobsData[i][2]) || 0;
      const pendingQtyCell = jobsData[i][3];

      const currentQty =
        pendingQtyCell !== "" && pendingQtyCell !== null
          ? Number(pendingQtyCell)
          : importedQty;

      const processedQty = Number(processedQtyValue) || 0;
      const remainingQty = currentQty - processedQty;

      if (remainingQty <= 0) {
        jobsSheet.getRange(i + 1, 4).clearContent();
        jobsSheet.getRange(i + 1, 5).setValue("COMPLETED");
      } else {
        jobsSheet.getRange(i + 1, 4).setValue(remainingQty);
        jobsSheet.getRange(i + 1, 5).setValue("PENDING");
      }

      break;
    }
  }
}

function updateNextProcessQueueStatus(nextProcessSheet, jobId, newStatus) {
  const queueData = nextProcessSheet.getDataRange().getValues();

  for (let i = 1; i < queueData.length; i++) {
    const rowJobId = queueData[i][2];

    if (String(rowJobId) === String(jobId)) {
      nextProcessSheet.getRange(i + 1, 8).setValue(newStatus);
    }
  }
}