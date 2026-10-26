import type { ProjectCheckpoint } from "./types";

/** Default handover sheet rows (Type / Item / Description) from the Compal CheckPoint spreadsheet. */
const TEMPLATE: Array<{ type: string; item: string; description: string }> = [
  // Basic information (Lists/SPEC)
  { type: "Basic information (Lists/SPEC)", item: "Verbtable", description: "Verbtable data" },
  { type: "Basic information (Lists/SPEC)", item: "Memory SPD table", description: "SPD data and ID list" },
  { type: "Basic information (Lists/SPEC)", item: "Panel", description: "Project panel ID list" },
  { type: "Basic information (Lists/SPEC)", item: "SSID/SVID", description: "Project ID list" },
  {
    type: "Basic information (Lists/SPEC)",
    item: "GOP",
    description: "GOP tool; Website and Account to get GOP and SOP",
  },
  {
    type: "Basic information (Lists/SPEC)",
    item: "ME FW",
    description: "ME package; Website and Account to get ME FW",
  },
  { type: "Basic information (Lists/SPEC)", item: "SPI ROM", description: "ROM ID list" },
  { type: "Basic information (Lists/SPEC)", item: "USB LAN dongle", description: "UNDI driver and version" },
  { type: "Basic information (Lists/SPEC)", item: "GPIO", description: "GPIO table" },
  {
    type: "Basic information (Lists/SPEC)",
    item: "Keypart information",
    description: "Buildplan(CPU/RAM/LAN/WLAN/SSD/TP/LCD); EC chip; Cardreader; Sensors; ......",
  },
  { type: "Basic information (Lists/SPEC)", item: "HW schematic", description: "" },
  { type: "Basic information (Lists/SPEC)", item: "PCID list", description: "" },
  { type: "Basic information (Lists/SPEC)", item: "NUDD", description: "" },
  {
    type: "Basic information (Lists/SPEC)",
    item: "Member list",
    description: "1. Compal member list; 2. BIOS vendor member list; 3. Lenovo member list; 4. Intel member list",
  },
  { type: "Basic information (Lists/SPEC)", item: "Build plan", description: "" },
  { type: "Basic information (Lists/SPEC)", item: "CHID list for WU", description: "" },
  { type: "Basic information (Lists/SPEC)", item: "Safe launch report", description: "" },
  { type: "Basic information (Lists/SPEC)", item: "QAD TDMS issue list", description: "" },
  {
    type: "Basic information (Lists/SPEC)",
    item: "MP waive issue list",
    description: "For tracking issue status after MP",
  },
  { type: "Basic information (Lists/SPEC)", item: "Function/Feature related SPEC", description: "" },
  { type: "Basic information (Lists/SPEC)", item: "MFG Guide/Whitepaper", description: "" },
  { type: "Basic information (Lists/SPEC)", item: "BIOS SPEC", description: "" },
  { type: "Basic information (Lists/SPEC)", item: "User guide", description: "" },
  {
    type: "Basic information (Lists/SPEC)",
    item: "Special W/A list",
    description: "EC name space / EC EEPROM / EC command",
  },
  { type: "Basic information (Lists/SPEC)", item: "Lesson Learn list", description: "" },

  // Code implement (website/SOP)
  { type: "Code implement (website/SOP)", item: "Build code environment", description: "" },
  { type: "Code implement (website/SOP)", item: "Code branch from which code base", description: "" },
  {
    type: "Code implement (website/SOP)",
    item: "List of issue fix code in kernel or project override",
    description: "Avoid some issue reopen.",
  },
  {
    type: "Code implement (website/SOP)",
    item: "Formal BIOS release process",
    description: "Release SOP including winflash/shell/WU and sign package",
  },
  {
    type: "Code implement (website/SOP)",
    item: "Formal ME release process",
    description: "Release SOP for ME update.",
  },
  {
    type: "Code implement (website/SOP)",
    item: "Kernel code update",
    description: "Common task and just training once",
  },
  {
    type: "Code implement (website/SOP)",
    item: "Secure code update",
    description: "Common task and just training once",
  },
  {
    type: "Code implement (website/SOP)",
    item: "FSP update",
    description: "Common task and just training once",
  },
  {
    type: "Code implement (website/SOP)",
    item: "CPU MCU",
    description: "Common task and just training once",
  },
  {
    type: "Code implement (website/SOP)",
    item: "PI update",
    description: "Common task and just training once",
  },
  {
    type: "Code implement (website/SOP)",
    item: "Diagnostics",
    description: "Version and system information maintain.",
  },

  // Permission
  {
    type: "Permission",
    item: "TPE SPEC server",
    description: "\\\\tpeswbios\\sw; No read/write permission now",
  },
  {
    type: "Permission",
    item: "TPE BIOS server",
    description: "\\\\tpeswbios\\ROM; Read only now",
  },
  {
    type: "Permission",
    item: "BIOS release system",
    description: "https://siee.compal.com/bios-ec-tasks/project/list; No read/write permission now",
  },
];

/** Build a fresh default CheckPoint sheet (new ids, all unchecked). */
export function buildDefaultCheckpointTemplate(): ProjectCheckpoint[] {
  return TEMPLATE.map((row) => ({
    id: crypto.randomUUID(),
    type: row.type,
    item: row.item,
    description: row.description,
    checked: false,
  }));
}
