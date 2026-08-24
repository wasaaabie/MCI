const STORAGE_KEY = "mci-board-patients-v1";
const LEGACY_STORAGE_KEY = ["man", "v-board-patients-v1"].join("");
const triageLabels = {
  red: "SK I · Rot",
  yellow: "SK II · Gelb",
  green: "SK III · Grün",
  black: "Verstorben",
  unassigned: "Ohne Einstufung"
};

const fields = [
  "name", "patientNumber", "gender", "age", "description", "triage", "triageTime",
  "injuries", "medication", "unitOnSite", "treatmentArea", "destinationHospital",
  "physician", "hospitalNotes", "notes"
];
const checkFields = ["treatedOnSite", "idCheckCode7", "readyForTransport", "transported", "admitted", "surgery", "treatedHospital", "idCheckHospital", "discharged"];

let patients = loadPatients();
const $ = (selector) => document.querySelector(selector);
const dialog = $("#patientDialog");
const form = $("#patientForm");
let toastTimer;

function loadPatients() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY) || "[]";
    const value = JSON.parse(stored);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function savePatients() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(patients));
  $("#saveState").textContent = `Lokal gespeichert · ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function formatDate(value) {
  if (!value) return "–";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "–" : date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

function render() {
  const query = $("#searchInput").value.trim().toLocaleLowerCase("de");
  const filter = $("#triageFilter").value;
  const visible = patients
    .filter(patient => !filter || (patient.triage || "unassigned") === filter)
    .filter(patient => !query || [patient.name, patient.patientNumber, patient.unitOnSite, patient.treatmentArea, patient.destinationHospital].some(value => String(value || "").toLocaleLowerCase("de").includes(query)))
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  ["red", "yellow", "green", "black"].forEach(category => {
    const counter = $(`#count${category[0].toUpperCase()}${category.slice(1)}`);
    if (counter) counter.textContent = patients.filter(patient => patient.triage === category).length;
  });
  $("#countAll").textContent = patients.length;
  $("#countReady").textContent = patients.filter(patient => patient.readyForTransport && !patient.transported && !patient.admitted).length;
  $("#countUnderway").textContent = patients.filter(patient => patient.transported && !patient.admitted).length;
  $("#countArrived").textContent = patients.filter(patient => patient.admitted).length;
  $("#emptyState").classList.toggle("hidden", patients.length > 0);
  $("#patientGrid").classList.toggle("hidden", patients.length === 0);

  $("#patientGrid").innerHTML = visible.length ? visible.map(patientCard).join("") : `<div class="no-results">Keine passenden Patienten gefunden.</div>`;
  document.querySelectorAll("[data-edit-id]").forEach(button => button.addEventListener("click", () => openDialog(button.dataset.editId)));
}

function patientCard(patient) {
  const triage = patient.triage || "unassigned";
  const transportState = patient.admitted ? "arrived" : patient.transported ? "underway" : patient.readyForTransport ? "ready" : "open";
  const history = Array.isArray(patient.triageHistory) ? patient.triageHistory : [];
  const lastTriageChange = history[history.length - 1];
  const statuses = [
    lastTriageChange && { label: `Triage: ${shortTriage(lastTriageChange.from)} → ${shortTriage(lastTriageChange.to)}`, style: "triage-change" },
    patient.treatedOnSite && { label: "Vor Ort behandelt", style: "" },
    transportState === "ready" && { label: "Transportbereit", style: "ready" },
    transportState === "underway" && { label: "Unterwegs", style: "underway" },
    transportState === "arrived" && { label: "Im Krankenhaus", style: "arrived" },
    patient.surgery && { label: "OP", style: "" }, patient.discharged && { label: "Entlassen", style: "" }
  ].filter(Boolean);
  return `<article class="patient-card" data-triage="${escapeHtml(triage)}" data-transport="${transportState}">
    <div class="card-top"><div><h2>${escapeHtml(patient.patientNumber || "Ohne Patientennummer")}</h2><span class="patient-no">${escapeHtml(patient.name || "Unbekannt")}</span></div><span class="triage-badge ${escapeHtml(triage)}">${escapeHtml(triageLabels[triage] || triageLabels.unassigned)}</span></div>
    <div class="card-details">
      <div class="detail"><span>Behandlungsplatz</span><strong title="${escapeHtml(patient.treatmentArea)}">${escapeHtml(patient.treatmentArea || "–")}</strong></div>
      <div class="detail"><span>Einheit vor Ort</span><strong title="${escapeHtml(patient.unitOnSite)}">${escapeHtml(patient.unitOnSite || "–")}</strong></div>
      <div class="detail"><span>Ziel</span><strong title="${escapeHtml(patient.destinationHospital)}">${escapeHtml(patient.destinationHospital || "–")}</strong></div>
      <div class="detail"><span>Sichtung</span><strong>${formatDate(patient.triageTime)}</strong></div>
    </div>
    <div class="status-row">${statuses.length ? statuses.map(status => `<span class="status-chip ${status.style}">${status.label}</span>`).join("") : `<span class="status-chip">Status offen</span>`}</div>
    <div class="card-footer"><span class="updated-at">Aktualisiert ${formatDate(patient.updatedAt)}</span><button class="edit-button" type="button" data-edit-id="${escapeHtml(patient.id)}">Öffnen</button></div>
  </article>`;
}

function openDialog(id = "") {
  form.reset();
  $("#patientId").value = id;
  const patient = patients.find(item => item.id === id);
  $("#dialogTitle").textContent = patient ? "Patient bearbeiten" : "Patient anlegen";
  $("#deleteBtn").classList.toggle("hidden", !patient);
  if (patient) {
    fields.forEach(field => { $(`#${field}`).value = patient[field] || (field === "triage" ? "unassigned" : ""); });
    checkFields.forEach(field => { $(`#${field}`).checked = Boolean(patient[field]); });
  } else {
    $("#triage").value = "unassigned";
    $("#triageTime").value = localDateTimeValue(new Date());
    $("#patientNumber").value = nextPatientNumber();
  }
  renderTriageHistory(patient);
  dialog.showModal();
  setTimeout(() => $("#name").focus(), 50);
}

function localDateTimeValue(date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function nextPatientNumber() {
  const used = patients.map(patient => Number(String(patient.patientNumber || "").match(/\d+/)?.[0])).filter(Number.isFinite);
  return `P-${String((used.length ? Math.max(...used) : 0) + 1).padStart(3, "0")}`;
}

function collectForm() {
  const existing = patients.find(item => item.id === $("#patientId").value);
  const patient = { id: existing?.id || (globalThis.crypto?.randomUUID?.() || `p-${Date.now()}`), createdAt: existing?.createdAt || new Date().toISOString() };
  fields.forEach(field => { patient[field] = $(`#${field}`).value.trim(); });
  checkFields.forEach(field => { patient[field] = $(`#${field}`).checked; });
  patient.updatedAt = new Date().toISOString();
  patient.triageHistory = Array.isArray(existing?.triageHistory) ? [...existing.triageHistory] : [];
  const previousTriage = existing?.triage || "unassigned";
  if (patient.triage !== previousTriage) {
    patient.triageHistory.push({ from: previousTriage, to: patient.triage, at: patient.updatedAt });
  }
  return patient;
}

function shortTriage(value) {
  return ({ red: "Rot", yellow: "Gelb", green: "Grün", black: "Schwarz", unassigned: "Offen" })[value] || "Offen";
}

function renderTriageHistory(patient, pendingTriage = "") {
  const entries = Array.isArray(patient?.triageHistory) ? [...patient.triageHistory] : [];
  if (patient && pendingTriage && pendingTriage !== patient.triage) {
    entries.push({ from: patient.triage || "unassigned", to: pendingTriage, at: new Date().toISOString(), pending: true });
  }
  $("#triageHistoryPanel").classList.toggle("hidden", entries.length === 0);
  $("#triageHistoryList").innerHTML = entries.slice().reverse().map(entry => `
    <div class="triage-history-entry${entry.pending ? " pending" : ""}">
      <span class="triage-dot ${escapeHtml(entry.to)}"></span>
      <span><strong>${shortTriage(entry.from)} → ${shortTriage(entry.to)}</strong>${entry.pending ? " · wird beim Speichern dokumentiert" : ""}</span>
      <time>${formatDate(entry.at)}</time>
    </div>`).join("");
}

form.addEventListener("submit", event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const patient = collectForm();
  const index = patients.findIndex(item => item.id === patient.id);
  if (index >= 0) patients[index] = patient; else patients.push(patient);
  savePatients(); render(); dialog.close(); showToast("Patientendatensatz gespeichert.");
});

$("#deleteBtn").addEventListener("click", () => {
  const id = $("#patientId").value;
  const patient = patients.find(item => item.id === id);
  if (!patient || !confirm(`Datensatz „${patient.name}“ wirklich löschen?`)) return;
  patients = patients.filter(item => item.id !== id);
  savePatients(); render(); dialog.close(); showToast("Patientendatensatz gelöscht.");
});

function showToast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2600);
}

$("#newPatientBtn").addEventListener("click", () => openDialog());
$("#emptyNewBtn").addEventListener("click", () => openDialog());
$("#closeDialogBtn").addEventListener("click", () => dialog.close());
$("#cancelBtn").addEventListener("click", () => dialog.close());
$("#searchInput").addEventListener("input", render);
$("#triageFilter").addEventListener("change", render);
$("#triage").addEventListener("change", event => {
  const patient = patients.find(item => item.id === $("#patientId").value);
  renderTriageHistory(patient, event.target.value);
});
dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });

render();
