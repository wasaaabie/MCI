const STORAGE_KEY = "manv-board-patients-v1";
const triageLabels = {
  red: "SK I · Rot",
  yellow: "SK II · Gelb",
  green: "SK III · Grün",
  blue: "SK IV · Blau",
  black: "Verstorben",
  unassigned: "Ohne Einstufung"
};

const fields = [
  "name", "patientNumber", "gender", "age", "description", "triage", "triageTime",
  "injuries", "medication", "unitOnSite", "treatmentArea", "transportUnit", "destinationHospital",
  "physician", "hospitalDepartment", "hospitalNotes", "notes"
];
const checkFields = ["treatedOnSite", "idCheckCode7", "transported", "admitted", "surgery", "treatedHospital", "idCheckHospital", "discharged"];

let patients = loadPatients();
const $ = (selector) => document.querySelector(selector);
const dialog = $("#patientDialog");
const form = $("#patientForm");
let toastTimer;

function loadPatients() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
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

  ["red", "yellow", "green", "blue", "black"].forEach(category => {
    $(`#count${category[0].toUpperCase()}${category.slice(1)}`).textContent = patients.filter(patient => patient.triage === category).length;
  });
  $("#countAll").textContent = patients.length;
  $("#emptyState").classList.toggle("hidden", patients.length > 0);
  $("#patientGrid").classList.toggle("hidden", patients.length === 0);

  $("#patientGrid").innerHTML = visible.length ? visible.map(patientCard).join("") : `<div class="no-results">Keine passenden Patienten gefunden.</div>`;
  document.querySelectorAll("[data-edit-id]").forEach(button => button.addEventListener("click", () => openDialog(button.dataset.editId)));
}

function patientCard(patient) {
  const triage = patient.triage || "unassigned";
  const statuses = [
    patient.treatedOnSite && "Vor Ort behandelt", patient.transported && "Abtransportiert",
    patient.admitted && "Eingeliefert", patient.surgery && "OP", patient.discharged && "Entlassen"
  ].filter(Boolean);
  return `<article class="patient-card" data-triage="${escapeHtml(triage)}">
    <div class="card-top"><div><h2>${escapeHtml(patient.name || "Unbekannt")}</h2><span class="patient-no">${escapeHtml(patient.patientNumber || "Ohne Patientennummer")}</span></div><span class="triage-badge ${escapeHtml(triage)}">${escapeHtml(triageLabels[triage] || triageLabels.unassigned)}</span></div>
    <div class="card-details">
      <div class="detail"><span>Behandlungsplatz</span><strong title="${escapeHtml(patient.treatmentArea)}">${escapeHtml(patient.treatmentArea || "–")}</strong></div>
      <div class="detail"><span>Einheit vor Ort</span><strong title="${escapeHtml(patient.unitOnSite)}">${escapeHtml(patient.unitOnSite || "–")}</strong></div>
      <div class="detail"><span>Ziel</span><strong title="${escapeHtml(patient.destinationHospital)}">${escapeHtml(patient.destinationHospital || "–")}</strong></div>
      <div class="detail"><span>Sichtung</span><strong>${formatDate(patient.triageTime)}</strong></div>
    </div>
    <div class="status-row">${statuses.length ? statuses.map(status => `<span class="status-chip">${status}</span>`).join("") : `<span class="status-chip">Status offen</span>`}</div>
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
  const patient = { id: existing?.id || (crypto.randomUUID?.() || `p-${Date.now()}`), createdAt: existing?.createdAt || new Date().toISOString() };
  fields.forEach(field => { patient[field] = $(`#${field}`).value.trim(); });
  checkFields.forEach(field => { patient[field] = $(`#${field}`).checked; });
  patient.updatedAt = new Date().toISOString();
  return patient;
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

function exportData() {
  const data = { application: "MANV Board", version: 1, exportedAt: new Date().toISOString(), patients };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `manv-board-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  URL.revokeObjectURL(url);
  showToast("Datensicherung exportiert.");
}

$("#importInput").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const imported = Array.isArray(data) ? data : data.patients;
    if (!Array.isArray(imported)) throw new Error("Ungültiges Format");
    if (!confirm(`${imported.length} Datensätze importieren? Vorhandene Datensätze mit gleicher ID werden ersetzt.`)) return;
    const merged = new Map(patients.map(patient => [patient.id, patient]));
    imported.forEach(patient => { if (patient && typeof patient === "object" && patient.id) merged.set(patient.id, patient); });
    patients = [...merged.values()]; savePatients(); render(); showToast("Datensicherung importiert.");
  } catch { showToast("Import fehlgeschlagen: ungültige JSON-Datei."); }
  finally { event.target.value = ""; }
});

$("#newPatientBtn").addEventListener("click", () => openDialog());
$("#emptyNewBtn").addEventListener("click", () => openDialog());
$("#closeDialogBtn").addEventListener("click", () => dialog.close());
$("#cancelBtn").addEventListener("click", () => dialog.close());
$("#searchInput").addEventListener("input", render);
$("#triageFilter").addEventListener("change", render);
$("#exportBtn").addEventListener("click", exportData);
$("#printBtn").addEventListener("click", () => window.print());
dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });

render();
