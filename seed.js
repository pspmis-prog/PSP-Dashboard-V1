// Seed data for the MES Masking Department Dashboard
const SEED_OPERATORS = [
  { id: "op-1", name: "Suresh Kumar", shift: "A Shift", jobsAssigned: 12, jobsCompleted: 10, activeTimeMs: 36000000 },
  { id: "op-2", name: "Rajesh Patil", shift: "B Shift", jobsAssigned: 8, jobsCompleted: 8, activeTimeMs: 28800000 },
  { id: "op-3", name: "Amit Mishra", shift: "C Shift", jobsAssigned: 5, jobsCompleted: 4, activeTimeMs: 18000000 },
  { id: "op-4", name: "Vijay Sharma", shift: "A Shift", jobsAssigned: 15, jobsCompleted: 14, activeTimeMs: 45000000 },
  { id: "op-5", name: "Vinod Yadav", shift: "B Shift", jobsAssigned: 9, jobsCompleted: 9, activeTimeMs: 32400000 }
];

const SEED_MATERIALS = [
  { id: "mat-1", name: "Masking Tape", type: "Tape", batch: "MT-2026-06", unit: "KG", plannedQty: 1.0, actualQty: 0 },
  { id: "mat-2", name: "High Temperature Putty", type: "Sealant", batch: "HTP-9921", unit: "Gram", plannedQty: 350, actualQty: 0 },
  { id: "mat-3", name: "Ceramic Protection Tape", type: "Tape", batch: "CPT-1044", unit: "KG", plannedQty: 0.8, actualQty: 0 },
  { id: "mat-4", name: "Silicone Plugs", type: "Masking Aid", batch: "SP-883", unit: "Gram", plannedQty: 120, actualQty: 0 },
  { id: "mat-5", name: "Metal Shielding Foil", type: "Foil", batch: "MSF-774", unit: "KG", plannedQty: 2.5, actualQty: 0 }
];

const SEED_JOBS = [
  {
    kpNumber: "KP-1001",
    partName: "Turbine Blade - Stage 1",
    customer: "HAL (Hindustan Aeronautics Ltd)",
    quantity: 5,
    processType: "Plasma",
    priority: "High",
    inspectionDate: "2026-06-14",
    receivedDate: "2026-06-15",
    currentDepartment: "Masking",
    status: "Pending", // Global Status
    operatorName: "",
    shift: "",
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
      materials: [
        { name: "Masking Tape", type: "Tape", batch: "MT-2026-06", unit: "KG", plannedQty: 5.0, actualQty: 0 },
        { name: "High Temperature Putty", type: "Sealant", batch: "HTP-9921", unit: "Gram", plannedQty: 350, actualQty: 0 }
      ]
    },
    spraying: { status: "Pending" },
    grinding: { status: "Pending" },
    polishing: { status: "Pending" },
    finalInspection: { status: "Pending" },
    dispatch: { status: "Pending" }
  },
  {
    kpNumber: "KP-1002",
    partName: "Gas Turbine Impeller",
    customer: "ISRO (Indian Space Research Org)",
    quantity: 2,
    processType: "HCOS",
    priority: "Critical",
    inspectionDate: "2026-06-13",
    receivedDate: "2026-06-15",
    currentDepartment: "Masking",
    status: "Pending",
    operatorName: "",
    shift: "",
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
      materials: [
        { name: "Ceramic Protection Tape", type: "Tape", batch: "CPT-1044", unit: "KG", plannedQty: 0.8, actualQty: 0 }
      ]
    },
    spraying: { status: "Pending" },
    grinding: { status: "Pending" },
    polishing: { status: "Pending" },
    finalInspection: { status: "Pending" },
    dispatch: { status: "Pending" }
  },
  {
    kpNumber: "KP-1003",
    partName: "Combustion Chamber Liner",
    customer: "BHEL (Bharat Heavy Electricals)",
    quantity: 10,
    processType: "Plasma",
    priority: "Normal",
    inspectionDate: "2026-06-14",
    receivedDate: "2026-06-15",
    currentDepartment: "Inspection", // Currently in Inspection (waiting for approval)
    status: "Inspection Pending",
    operatorName: "",
    shift: "",
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
    spraying: { status: "Pending" }
  },
  {
    kpNumber: "KP-1004",
    partName: "Nozzle Guide Vane",
    customer: "GE Aviation India",
    quantity: 8,
    processType: "HCOS",
    priority: "High",
    inspectionDate: "2026-06-14",
    receivedDate: "2026-06-15",
    currentDepartment: "Masking",
    status: "Pending",
    operatorName: "",
    shift: "",
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
      materials: [
        { name: "Masking Tape", type: "Tape", batch: "MT-2026-06", unit: "KG", plannedQty: 2.0, actualQty: 0 },
        { name: "Silicone Plugs", type: "Masking Aid", batch: "SP-883", unit: "Gram", plannedQty: 200, actualQty: 0 }
      ]
    },
    spraying: { status: "Pending" }
  },
  // A pre-completed job for history
  {
    kpNumber: "KP-0985",
    partName: "Compressor Rotor",
    customer: "Siemens India",
    quantity: 1,
    processType: "HCOS",
    priority: "Normal",
    inspectionDate: "2026-06-12",
    receivedDate: "2026-06-13",
    currentDepartment: "Spraying", // Already passed masking
    status: "Completed",
    operatorName: "Rajesh Patil",
    shift: "B Shift",
    masking: {
      operatorName: "Rajesh Patil",
      shift: "B Shift",
      status: "Completed",
      startTime: "2026-06-13T09:15:00Z",
      endTime: "2026-06-13T10:45:00Z",
      durationMs: 5400000, // 1.5 hours
      activeTimeMs: 5400000,
      lastStartedAt: "2026-06-13T09:15:00Z",
      lastPausedAt: null,
      holdHistory: [],
      materials: [
        { name: "Masking Tape", type: "Tape", batch: "MT-2026-06", unit: "KG", plannedQty: 1.0, actualQty: 0.95 }
      ]
    },
    spraying: { status: "Pending" }
  }
];

const SEED_AUDIT_LOGS = [
  { timestamp: "2026-06-15T08:00:00Z", user: "Supervisor A", department: "Inspection", kpNumber: "KP-1001", action: "Job Received" },
  { timestamp: "2026-06-15T08:05:00Z", user: "Supervisor A", department: "Inspection", kpNumber: "KP-1002", action: "Job Received" },
  { timestamp: "2026-06-15T08:10:00Z", user: "Supervisor A", department: "Inspection", kpNumber: "KP-1004", action: "Job Received" },
  { timestamp: "2026-06-13T10:45:00Z", user: "Rajesh Patil", department: "Masking", kpNumber: "KP-0985", action: "Job Completed" }
];
