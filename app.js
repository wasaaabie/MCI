const STORAGE_KEY = "mci-board-patients-v1";
const LEGACY_STORAGE_KEY = ["man", "v-board-patients-v1"].join("");
const MIGRATION_KEY = "mci-board-supabase-migration-v1";
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

let patients = [];
let incidents = [];
let currentIncident = null;
let db = null;
let currentUser = null;
let activeUserId = "";
let realtimeChannel = null;
let reloadTimer = null;
let migrationChecked = false;
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const dialog = $("#patientDialog");
const form = $("#patientForm");

function getConfig() {
  const config = window.MCI_CONFIG || {};
  const url = String(config.supabaseUrl || "").trim();
  const key = String(config.supabasePublishableKey || "").trim();
  const valid = url.startsWith("https://") && url.includes(".supabase.co") && !url.includes("DEIN-") && key.length > 20 && !key.includes("DEIN-");
  return { url, key, valid };
}

async function initialize() {
  const config = getConfig();
  if (!config.valid || !window.supabase?.createClient) {
    $("#configWarning").classList.remove("hidden");
    $("#loginBtn").disabled = true;
    return;
  }

  db = window.supabase.createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const { data, error } = await db.auth.getSession();
  if (error) setAuthError("Die Anmeldung konnte nicht geprüft werden.");
  await applySession(data?.session || null);

  db.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => applySession(session), 0);
  });
}

async function applySession(session) {
  const user = session?.user || null;
  if (!user) {
    activeUserId = "";
    currentUser = null;
    stopRealtime();
    patients = [];
    showLogin();
    return;
  }
  if (activeUserId === user.id) return;

  const { data: membership, error } = await db
    .from("mci_members")
    .select("display_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !membership) {
    await db.auth.signOut();
    showLogin();
    setAuthError("Dieses Konto ist nicht für das MCI Board freigegeben.");
    return;
  }

  activeUserId = user.id;
  currentUser = user;
  $("#userEmail").textContent = membership.display_name || user.email || "Einsatzkonto";
  $("#authGate").classList.add("hidden");
  $("#appHeader").classList.remove("hidden");
  setAuthError("");
  await loadIncidents();
  showIncidentOverview();
  startRealtime();
}

function showLogin() {
  $("#authGate").classList.remove("hidden");
  $("#appHeader").classList.add("hidden");
  $("#incidentMain").classList.add("hidden");
  $("#appMain").classList.add("hidden");
  if (dialog.open) dialog.close();
}

function setAuthError(message) {
  $("#loginError").textContent = message;
  $("#loginError").classList.toggle("hidden", !message);
}

async function loadIncidents() {
  if (!db || !currentUser) return;
  const { data, error } = await db
    .from("incidents")
    .select("id, title, location, description, status, started_at, closed_at, created_at, updated_at")
    .order("started_at", { ascending: false });
  if (error) {
    showToast("MCI-Liste konnte nicht geladen werden.");
    return;
  }
  const { data: patientRefs } = await db.from("patients").select("incident_id");
  const counts = (patientRefs || []).reduce((result, row) => {
    result[row.incident_id] = (result[row.incident_id] || 0) + 1;
    return result;
  }, {});
  incidents = (data || []).map(incident => ({ ...incident, patientCount: counts[incident.id] || 0 }));
  if (currentIncident) currentIncident = incidents.find(item => item.id === currentIncident.id) || currentIncident;
  renderIncidents();
}

async function loadRemotePatients() {
  if (!db || !currentUser || !currentIncident) return;
  $("#saveState").textContent = "Synchronisiere …";
  const { data, error } = await db
    .from("patients")
    .select("id, data, created_at, updated_at, incident_id")
    .eq("incident_id", currentIncident.id)
    .order("updated_at", { ascending: false });

  if (error) {
    $("#saveState").textContent = "Synchronisierung fehlgeschlagen";
    showToast("Patientendaten konnten nicht geladen werden.");
    return;
  }

  patients = (data || []).map(row => ({
    ...(row.data && typeof row.data === "object" ? row.data : {}),
    id: row.id,
    createdAt: row.data?.createdAt || row.created_at,
    updatedAt: row.updated_at
  }));
  render();
  $("#saveState").textContent = `Live · ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
  await offerLocalMigration();
}

function startRealtime() {
  stopRealtime();
  realtimeChannel = db
    .channel("mci-board-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "incidents" }, () => {
      loadIncidents();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "patients" }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        loadIncidents();
        if (currentIncident) loadRemotePatients();
      }, 150);
    })
    .subscribe();
}

function stopRealtime() {
  clearTimeout(reloadTimer);
  if (realtimeChannel && db) db.removeChannel(realtimeChannel);
  realtimeChannel = null;
}

function renderIncidents() {
  const active = incidents.filter(item => item.status === "active");
  const closed = incidents.filter(item => item.status === "closed");
  $("#activeIncidentGrid").innerHTML = active.length
    ? active.map(incidentCard).join("")
    : `<div class="incident-empty">Aktuell läuft keine MCI. Lege ein neues Einsatzblatt an.</div>`;
  $("#closedIncidentGrid").innerHTML = closed.length
    ? closed.map(incidentCard).join("")
    : `<div class="incident-empty">Noch keine abgeschlossenen MCIs vorhanden.</div>`;
  $("#historyCount").textContent = closed.length;
  document.querySelectorAll("[data-incident-id]").forEach(button => {
    button.addEventListener("click", () => openIncident(button.dataset.incidentId));
  });
}

function incidentCard(incident) {
  const closed = incident.status === "closed";
  return `<article class="incident-card ${closed ? "closed" : "active"}">
    <div class="incident-card-top">
      <div><h3>${escapeHtml(incident.title)}</h3><p>${escapeHtml(incident.location || "Ohne Ortsangabe")}</p></div>
      <span class="incident-state${closed ? " closed" : ""}">${closed ? "Abgeschlossen" : "Aktiv"}</span>
    </div>
    <div class="incident-card-details">
      <div><span>Beginn</span><strong>${formatDate(incident.started_at)}</strong></div>
      <div><span>Patienten</span><strong>${incident.patientCount || 0}</strong></div>
    </div>
    <div class="incident-card-footer">
      <small>${closed ? `Beendet ${formatDate(incident.closed_at)}` : "Laufender Einsatz"}</small>
      <button class="edit-button" type="button" data-incident-id="${incident.id}">${closed ? "Historie öffnen" : "MCI öffnen"}</button>
    </div>
  </article>`;
}

function showIncidentOverview() {
  currentIncident = null;
  patients = [];
  $("#pageTitle").textContent = "MCI Übersicht";
  $("#incidentMain").classList.remove("hidden");
  $("#appMain").classList.add("hidden");
  $("#backToIncidentsBtn").classList.add("hidden");
  $("#closeIncidentBtn").classList.add("hidden");
  $("#newPatientBtn").classList.add("hidden");
  $("#newIncidentBtn").classList.remove("hidden");
  $("#saveState").textContent = "Live synchronisiert";
  renderIncidents();
}

async function openIncident(id) {
  const incident = incidents.find(item => item.id === id);
  if (!incident) return;
  currentIncident = incident;
  const closed = incident.status === "closed";
  $("#incidentMain").classList.add("hidden");
  $("#appMain").classList.remove("hidden");
  $("#pageTitle").textContent = incident.title;
  $("#incidentTitle").textContent = incident.title;
  $("#incidentStatusLabel").textContent = closed ? "Abgeschlossene MCI" : "Aktive MCI";
  $("#incidentMeta").textContent = `${incident.location || "Ohne Ortsangabe"} · Beginn ${formatDate(incident.started_at)}`;
  $("#readOnlyBadge").classList.toggle("hidden", !closed);
  $("#backToIncidentsBtn").classList.remove("hidden");
  $("#newIncidentBtn").classList.add("hidden");
  $("#newPatientBtn").classList.toggle("hidden", closed);
  $("#closeIncidentBtn").classList.toggle("hidden", closed);
  await loadRemotePatients();
}

function openIncidentDialog() {
  $("#incidentForm").reset();
  $("#newIncidentStartedAt").value = localDateTimeValue(new Date());
  $("#incidentDialog").showModal();
  setTimeout(() => $("#newIncidentTitle").focus(), 50);
}

function readLocalPatients() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY) || "[]";
    const value = JSON.parse(stored);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function offerLocalMigration() {
  if (migrationChecked || !currentIncident || localStorage.getItem(MIGRATION_KEY)) return;
  migrationChecked = true;
  const localPatients = readLocalPatients();
  if (!localPatients.length) return;
  const { count } = await db.from("patients").select("id", { count: "exact", head: true });
  if (count) return;
  if (!confirm(`${localPatients.length} lokal gespeicherte Datensätze in die gemeinsame Datenbank übernehmen?`)) return;

  const rows = localPatients.map(item => {
    const patient = { ...item, id: isUuid(item.id) ? item.id : createUuid() };
    return {
      id: patient.id,
      data: patient,
      incident_id: currentIncident.id,
      updated_by: currentUser.id,
      updated_at: patient.updatedAt || new Date().toISOString()
    };
  });
  const { error } = await db.from("patients").upsert(rows);
  if (error) {
    showToast("Lokale Datensätze konnten nicht übernommen werden.");
    return;
  }
  localStorage.setItem(MIGRATION_KEY, new Date().toISOString());
  showToast("Lokale Datensätze wurden übernommen.");
  await loadRemotePatients();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
    const random = Math.floor(Math.random() * 16);
    return (char === "x" ? random : (random & 3) | 8).toString(16);
  });
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
    <div class="card-footer"><span class="updated-at">Aktualisiert ${formatDate(patient.updatedAt)}</span><button class="edit-button" type="button" data-edit-id="${escapeHtml(patient.id)}">${currentIncident?.status === "closed" ? "Ansehen" : "Öffnen"}</button></div>
  </article>`;
}

function openDialog(id = "") {
  form.reset();
  const readOnly = currentIncident?.status === "closed";
  $("#patientId").value = id;
  const patient = patients.find(item => item.id === id);
  $("#dialogTitle").textContent = readOnly ? "Patient ansehen" : patient ? "Patient bearbeiten" : "Patient anlegen";
  $("#deleteBtn").classList.toggle("hidden", !patient || readOnly);
  if (patient) {
    fields.forEach(field => { $(`#${field}`).value = patient[field] || (field === "triage" ? "unassigned" : ""); });
    checkFields.forEach(field => { $(`#${field}`).checked = Boolean(patient[field]); });
  } else {
    $("#triage").value = "unassigned";
    $("#triageTime").value = localDateTimeValue(new Date());
    $("#patientNumber").value = nextPatientNumber();
  }
  form.querySelectorAll("input, select, textarea").forEach(control => { control.disabled = readOnly; });
  $("#savePatientBtn").classList.toggle("hidden", readOnly);
  $("#cancelBtn").textContent = readOnly ? "Schließen" : "Abbrechen";
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
  const patient = { id: existing?.id || createUuid(), createdAt: existing?.createdAt || new Date().toISOString() };
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

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!form.reportValidity() || !currentUser || currentIncident?.status !== "active") return;
  const button = $("#savePatientBtn");
  button.disabled = true;
  button.textContent = "Speichert …";
  const patient = collectForm();
  const { error } = await db.from("patients").upsert({
    id: patient.id,
    data: patient,
    incident_id: currentIncident.id,
    updated_by: currentUser.id,
    updated_at: patient.updatedAt
  });
  button.disabled = false;
  button.textContent = "Datensatz speichern";
  if (error) {
    showToast("Speichern fehlgeschlagen. Bitte erneut versuchen.");
    return;
  }
  const index = patients.findIndex(item => item.id === patient.id);
  if (index >= 0) patients[index] = patient; else patients.push(patient);
  render();
  dialog.close();
  $("#saveState").textContent = "Synchronisiert";
  showToast("Patientendatensatz gespeichert.");
});

$("#deleteBtn").addEventListener("click", async () => {
  if (currentIncident?.status !== "active") return;
  const id = $("#patientId").value;
  const patient = patients.find(item => item.id === id);
  if (!patient || !confirm(`Datensatz „${patient.name}“ wirklich löschen?`)) return;
  $("#deleteBtn").disabled = true;
  const { error } = await db.from("patients").delete().eq("id", id);
  $("#deleteBtn").disabled = false;
  if (error) {
    showToast("Löschen fehlgeschlagen. Bitte erneut versuchen.");
    return;
  }
  patients = patients.filter(item => item.id !== id);
  render();
  dialog.close();
  showToast("Patientendatensatz gelöscht.");
});

function showToast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 3000);
}

$("#incidentForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!$("#incidentForm").reportValidity() || !currentUser) return;
  const button = $("#saveIncidentBtn");
  button.disabled = true;
  button.textContent = "Wird angelegt …";
  const incident = {
    id: createUuid(),
    title: $("#newIncidentTitle").value.trim(),
    location: $("#newIncidentLocation").value.trim(),
    description: $("#newIncidentDescription").value.trim(),
    status: "active",
    started_at: new Date($("#newIncidentStartedAt").value).toISOString(),
    created_by: currentUser.id,
    updated_at: new Date().toISOString()
  };
  const { error } = await db.from("incidents").insert(incident);
  button.disabled = false;
  button.textContent = "MCI anlegen";
  if (error) {
    showToast("MCI konnte nicht angelegt werden.");
    return;
  }
  $("#incidentDialog").close();
  await loadIncidents();
  await openIncident(incident.id);
  showToast("Neue MCI wurde angelegt.");
});

$("#closeIncidentBtn").addEventListener("click", async () => {
  if (!currentIncident || currentIncident.status !== "active") return;
  if (!confirm(`MCI „${currentIncident.title}“ abschließen? Danach ist das Einsatzblatt schreibgeschützt.`)) return;
  const closedAt = new Date().toISOString();
  const { error } = await db.from("incidents").update({ status: "closed", closed_at: closedAt, updated_at: closedAt }).eq("id", currentIncident.id);
  if (error) {
    showToast("MCI konnte nicht abgeschlossen werden.");
    return;
  }
  await loadIncidents();
  showIncidentOverview();
  showToast("MCI abgeschlossen und in die Historie verschoben.");
});

$("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!db) return;
  const button = $("#loginBtn");
  button.disabled = true;
  button.textContent = "Anmeldung läuft …";
  setAuthError("");
  const { error } = await db.auth.signInWithPassword({
    email: $("#loginEmail").value.trim(),
    password: $("#loginPassword").value
  });
  button.disabled = false;
  button.textContent = "Anmelden";
  if (error) setAuthError("E-Mail-Adresse oder Passwort ist nicht korrekt.");
});

$("#logoutBtn").addEventListener("click", async () => {
  if (db) await db.auth.signOut();
});
$("#newIncidentBtn").addEventListener("click", openIncidentDialog);
$("#newIncidentMainBtn").addEventListener("click", openIncidentDialog);
$("#backToIncidentsBtn").addEventListener("click", showIncidentOverview);
$("#closeIncidentDialogBtn").addEventListener("click", () => $("#incidentDialog").close());
$("#cancelIncidentBtn").addEventListener("click", () => $("#incidentDialog").close());
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
$("#incidentDialog").addEventListener("click", event => { if (event.target === $("#incidentDialog")) $("#incidentDialog").close(); });

initialize();
