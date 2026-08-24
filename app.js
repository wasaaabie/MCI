const STORAGE_KEY = "mci-board-patients-v1";
const LEGACY_STORAGE_KEY = ["man", "v-board-patients-v1"].join("");
const MIGRATION_KEY = "mci-board-supabase-migration-v1";
const NAV_COLLAPSED_KEY = "mci-board-nav-collapsed";
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
let activities = [];
let bulletinEntries = [];
let labEntries = [];
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

function setNavCollapsed(collapsed) {
  const nav = $("#appNav");
  const button = $("#navCollapseBtn");
  nav.classList.toggle("collapsed", collapsed);
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", collapsed ? "Menü ausklappen" : "Menü einklappen");
  button.title = collapsed ? "Menü ausklappen" : "Menü einklappen";
  localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
}

setNavCollapsed(localStorage.getItem(NAV_COLLAPSED_KEY) === "1");

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
  $("#appNav").classList.remove("hidden");
  setAuthError("");
  await loadIncidents();
  showIncidentOverview();
  startRealtime();
}

function showLogin() {
  bulletinEntries = [];
  labEntries = [];
  $("#authGate").classList.remove("hidden");
  $("#appHeader").classList.add("hidden");
  $("#appNav").classList.add("hidden");
  $("#bulletinMain").classList.add("hidden");
  $("#labMain").classList.add("hidden");
  $("#incidentMain").classList.add("hidden");
  $("#appMain").classList.add("hidden");
  if (dialog.open) dialog.close();
  if ($("#incidentDialog").open) $("#incidentDialog").close();
  if ($("#bulletinDialog").open) $("#bulletinDialog").close();
  if ($("#labDialog").open) $("#labDialog").close();
}

function setAuthError(message) {
  $("#loginError").textContent = message;
  $("#loginError").classList.toggle("hidden", !message);
}

async function loadIncidents() {
  if (!db || !currentUser) return;
  const { data, error } = await db
    .from("incidents")
    .select("id, title, location, scene_lead, description, status, started_at, closed_at, created_at, updated_at")
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
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log" }, payload => {
      if (currentIncident && payload.new?.incident_id === currentIncident.id) loadActivity();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "bulletin_entries" }, () => {
      if (!$("#bulletinMain").classList.contains("hidden")) loadBulletinEntries();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "lab_requests" }, () => {
      if (!$("#labMain").classList.contains("hidden")) loadLabEntries();
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
      <div><span>Scene Lead</span><strong>${escapeHtml(incident.scene_lead || "Unbekannt")}</strong></div>
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
  activities = [];
  $("#pageTitle").textContent = "MCI Übersicht";
  $("#bulletinMain").classList.add("hidden");
  $("#labMain").classList.add("hidden");
  $("#incidentMain").classList.remove("hidden");
  $("#appMain").classList.add("hidden");
  $("#closeIncidentBtn").classList.add("hidden");
  $("#newPatientBtn").classList.add("hidden");
  $("#newBulletinBtn").classList.add("hidden");
  $("#newLabBtn").classList.add("hidden");
  $("#newIncidentBtn").classList.remove("hidden");
  setActiveNav("incidents");
  $("#saveState").textContent = "Live synchronisiert";
  renderIncidents();
}

async function openIncident(id) {
  const incident = incidents.find(item => item.id === id);
  if (!incident) return;
  currentIncident = incident;
  const closed = incident.status === "closed";
  $("#incidentMain").classList.add("hidden");
  $("#bulletinMain").classList.add("hidden");
  $("#labMain").classList.add("hidden");
  $("#appMain").classList.remove("hidden");
  $("#pageTitle").textContent = incident.title;
  $("#incidentTitle").textContent = incident.title;
  $("#incidentStatusLabel").textContent = closed ? "Abgeschlossene MCI" : "Aktive MCI";
  $("#incidentMeta").textContent = `${incident.location || "Ohne Ortsangabe"} · Scene Lead: ${incident.scene_lead || "Unbekannt"} · Beginn ${formatDate(incident.started_at)}`;
  $("#readOnlyBadge").classList.toggle("hidden", !closed);
  $("#newIncidentBtn").classList.add("hidden");
  $("#newBulletinBtn").classList.add("hidden");
  $("#newLabBtn").classList.add("hidden");
  $("#newPatientBtn").classList.toggle("hidden", closed);
  $("#closeIncidentBtn").classList.toggle("hidden", closed);
  setActiveNav("incidents");
  await loadRemotePatients();
  await loadActivity();
}

function openIncidentDialog() {
  $("#incidentForm").reset();
  $("#newIncidentStartedAt").value = localDateTimeValue(new Date());
  $("#incidentDialog").showModal();
  setTimeout(() => $("#newIncidentTitle").focus(), 50);
}

async function showBulletinBoard() {
  currentIncident = null;
  patients = [];
  activities = [];
  $("#pageTitle").textContent = "Schwarzes Brett";
  $("#incidentMain").classList.add("hidden");
  $("#appMain").classList.add("hidden");
  $("#labMain").classList.add("hidden");
  $("#bulletinMain").classList.remove("hidden");
  $("#newIncidentBtn").classList.add("hidden");
  $("#newPatientBtn").classList.add("hidden");
  $("#closeIncidentBtn").classList.add("hidden");
  $("#newBulletinBtn").classList.remove("hidden");
  $("#newLabBtn").classList.add("hidden");
  setActiveNav("bulletin");
  await loadBulletinEntries();
}

function setActiveNav(section) {
  $("#navIncidentsBtn").classList.toggle("active", section === "incidents");
  $("#navBulletinBtn").classList.toggle("active", section === "bulletin");
  $("#navLabBtn").classList.toggle("active", section === "lab");
  $("#navIncidentsBtn").setAttribute("aria-current", section === "incidents" ? "page" : "false");
  $("#navBulletinBtn").setAttribute("aria-current", section === "bulletin" ? "page" : "false");
  $("#navLabBtn").setAttribute("aria-current", section === "lab" ? "page" : "false");
}

function openBulletinDialog(id = "") {
  $("#bulletinForm").reset();
  $("#bulletinEntryId").value = id;
  const entry = bulletinEntries.find(item => item.id === id);
  $("#bulletinDialogTitle").textContent = entry ? "Eintrag bearbeiten" : "Eintrag anlegen";
  $("#saveBulletinBtn").textContent = entry ? "Änderungen speichern" : "Eintrag speichern";
  if (entry) {
    $("#bulletinPatientName").value = entry.patient_name;
    $("#bulletinPhone").value = entry.phone;
    $("#bulletinConcern").value = entry.concern;
  }
  $("#bulletinDialog").showModal();
  setTimeout(() => $("#bulletinPatientName").focus(), 50);
}

async function loadBulletinEntries() {
  if (!db || !currentUser) return;
  const { data, error } = await db
    .from("bulletin_entries")
    .select("id, patient_name, phone, concern, status, created_by_name, created_at, updated_by_name, updated_at, completed_by_name, completed_at")
    .order("created_at", { ascending: false });
  bulletinEntries = error ? [] : (data || []);
  if (error) showToast("Einträge des Schwarzen Bretts konnten nicht geladen werden.");
  renderBulletinEntries();
}

function renderBulletinEntries() {
  const openEntries = bulletinEntries.filter(entry => entry.status === "open");
  const closedEntries = bulletinEntries.filter(entry => entry.status === "done").sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
  $("#openBulletinCount").textContent = openEntries.length;
  $("#closedBulletinCount").textContent = closedEntries.length;
  $("#openBulletinBody").innerHTML = openEntries.length ? openEntries.map(openBulletinRow).join("") : `<tr><td class="table-empty" colspan="6">Keine offenen Einträge vorhanden.</td></tr>`;
  $("#closedBulletinBody").innerHTML = closedEntries.length ? closedEntries.map(closedBulletinRow).join("") : `<tr><td class="table-empty" colspan="6">Noch keine erledigten Einträge vorhanden.</td></tr>`;
  document.querySelectorAll("[data-complete-bulletin]").forEach(button => button.addEventListener("click", () => completeBulletinEntry(button.dataset.completeBulletin)));
  document.querySelectorAll("[data-edit-bulletin]").forEach(button => button.addEventListener("click", () => openBulletinDialog(button.dataset.editBulletin)));
}

function openBulletinRow(entry) {
  const edited = entry.updated_at ? `<br><small>Bearbeitet von ${escapeHtml(entry.updated_by_name || "Unbekannt")} · ${formatDate(entry.updated_at)}</small>` : "";
  return `<tr><td><strong>${escapeHtml(entry.patient_name)}</strong></td><td>${escapeHtml(entry.phone)}</td><td class="bulletin-concern">${escapeHtml(entry.concern)}</td><td><strong>${escapeHtml(entry.created_by_name || "Unbekannt")}</strong>${edited}</td><td class="bulletin-date">${formatDate(entry.created_at)}</td><td><div class="bulletin-actions"><button class="bulletin-edit-button" type="button" data-edit-bulletin="${entry.id}">Bearbeiten</button><button class="complete-button" type="button" data-complete-bulletin="${entry.id}">Erledigt</button></div></td></tr>`;
}

function closedBulletinRow(entry) {
  return `<tr><td><strong>${escapeHtml(entry.patient_name)}</strong></td><td>${escapeHtml(entry.phone)}</td><td class="bulletin-concern">${escapeHtml(entry.concern)}</td><td>${escapeHtml(entry.created_by_name || "Unbekannt")}<br><small>${formatDate(entry.created_at)}</small></td><td>${escapeHtml(entry.completed_by_name || "Unbekannt")}</td><td class="bulletin-date">${formatDate(entry.completed_at)}</td></tr>`;
}

async function completeBulletinEntry(id) {
  const entry = bulletinEntries.find(item => item.id === id);
  if (!entry || !confirm(`Eintrag für „${entry.patient_name}“ als erledigt markieren?`)) return;
  const { error } = await db.from("bulletin_entries").update({ status: "done" }).eq("id", id).eq("status", "open");
  if (error) {
    showToast("Eintrag konnte nicht abgeschlossen werden.");
    return;
  }
  await loadBulletinEntries();
  showToast("Eintrag wurde in die Historie verschoben.");
}

async function showLabRequests() {
  currentIncident = null;
  patients = [];
  activities = [];
  $("#pageTitle").textContent = "Labor Requests";
  $("#incidentMain").classList.add("hidden");
  $("#appMain").classList.add("hidden");
  $("#bulletinMain").classList.add("hidden");
  $("#labMain").classList.remove("hidden");
  $("#newIncidentBtn").classList.add("hidden");
  $("#newPatientBtn").classList.add("hidden");
  $("#newBulletinBtn").classList.add("hidden");
  $("#closeIncidentBtn").classList.add("hidden");
  $("#newLabBtn").classList.remove("hidden");
  setActiveNav("lab");
  await loadLabEntries();
}

function openLabDialog(id = "") {
  $("#labForm").reset();
  $("#labEntryId").value = id;
  const entry = labEntries.find(item => item.id === id);
  $("#labDialogTitle").textContent = entry ? "Request bearbeiten" : "Request anlegen";
  $("#saveLabBtn").textContent = entry ? "Änderungen speichern" : "Request speichern";
  if (entry) {
    $("#labPatientName").value = entry.patient_name;
    $("#labPhone").value = entry.phone;
    $("#labSampleNumber").value = entry.sample_number || "";
    $("#labNote").value = entry.note;
  }
  $("#labDialog").showModal();
  setTimeout(() => $("#labPatientName").focus(), 50);
}

async function loadLabEntries() {
  if (!db || !currentUser) return;
  const { data, error } = await db
    .from("lab_requests")
    .select("id, patient_name, phone, sample_number, note, status, created_by_name, created_at, updated_by_name, updated_at, completed_by_name, completed_at")
    .order("created_at", { ascending: false });
  labEntries = error ? [] : (data || []);
  if (error) showToast("Labor Requests konnten nicht geladen werden.");
  renderLabEntries();
}

function renderLabEntries() {
  const openEntries = labEntries.filter(entry => entry.status === "open");
  const closedEntries = labEntries.filter(entry => entry.status === "done").sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
  $("#openLabCount").textContent = openEntries.length;
  $("#closedLabCount").textContent = closedEntries.length;
  $("#openLabBody").innerHTML = openEntries.length ? openEntries.map(openLabRow).join("") : `<tr><td class="table-empty" colspan="7">Keine offenen Labor Requests vorhanden.</td></tr>`;
  $("#closedLabBody").innerHTML = closedEntries.length ? closedEntries.map(closedLabRow).join("") : `<tr><td class="table-empty" colspan="7">Noch keine erledigten Labor Requests vorhanden.</td></tr>`;
  document.querySelectorAll("[data-complete-lab]").forEach(button => button.addEventListener("click", () => completeLabEntry(button.dataset.completeLab)));
  document.querySelectorAll("[data-edit-lab]").forEach(button => button.addEventListener("click", () => openLabDialog(button.dataset.editLab)));
}

function openLabRow(entry) {
  const edited = entry.updated_at ? `<br><small>Bearbeitet von ${escapeHtml(entry.updated_by_name || "Unbekannt")} · ${formatDate(entry.updated_at)}</small>` : "";
  return `<tr><td><strong>${escapeHtml(entry.patient_name)}</strong></td><td>${escapeHtml(entry.phone)}</td><td>${escapeHtml(entry.sample_number || "–")}</td><td class="bulletin-concern">${escapeHtml(entry.note)}</td><td><strong>${escapeHtml(entry.created_by_name || "Unbekannt")}</strong>${edited}</td><td class="bulletin-date">${formatDate(entry.created_at)}</td><td><div class="bulletin-actions"><button class="bulletin-edit-button" type="button" data-edit-lab="${entry.id}">Bearbeiten</button><button class="complete-button" type="button" data-complete-lab="${entry.id}">Erledigt</button></div></td></tr>`;
}

function closedLabRow(entry) {
  return `<tr><td><strong>${escapeHtml(entry.patient_name)}</strong></td><td>${escapeHtml(entry.phone)}</td><td>${escapeHtml(entry.sample_number || "–")}</td><td class="bulletin-concern">${escapeHtml(entry.note)}</td><td>${escapeHtml(entry.created_by_name || "Unbekannt")}<br><small>${formatDate(entry.created_at)}</small></td><td>${escapeHtml(entry.completed_by_name || "Unbekannt")}</td><td class="bulletin-date">${formatDate(entry.completed_at)}</td></tr>`;
}

async function completeLabEntry(id) {
  const entry = labEntries.find(item => item.id === id);
  if (!entry || !confirm(`Labor Request für „${entry.patient_name}“ als erledigt markieren?`)) return;
  const { error } = await db.from("lab_requests").update({ status: "done" }).eq("id", id).eq("status", "open");
  if (error) {
    showToast("Labor Request konnte nicht abgeschlossen werden.");
    return;
  }
  await loadLabEntries();
  showToast("Labor Request wurde in die Historie verschoben.");
}

async function loadActivity() {
  if (!db || !currentUser || !currentIncident) return;
  const { data, error } = await db
    .from("activity_log")
    .select("id, action, subject_label, changed_fields, display_name, created_at")
    .eq("incident_id", currentIncident.id)
    .order("created_at", { ascending: false })
    .limit(100);
  activities = error ? [] : (data || []);
  renderActivity();
}

function renderActivity() {
  $("#activityCount").textContent = activities.length;
  $("#activityList").innerHTML = activities.length
    ? activities.map(activityEntry).join("")
    : `<div class="activity-empty">Für diese MCI wurden noch keine Änderungen protokolliert.</div>`;
}

function activityEntry(entry) {
  const actionLabels = {
    incident_created: "hat die MCI angelegt",
    incident_closed: "hat die MCI abgeschlossen",
    patient_created: `hat Patient ${entry.subject_label || ""} angelegt`,
    patient_updated: `hat Patient ${entry.subject_label || ""} bearbeitet`,
    patient_deleted: `hat Patient ${entry.subject_label || ""} gelöscht`
  };
  const fieldLabels = {
    name: "Name", patientNumber: "Patientennummer", gender: "Geschlecht", age: "Alter/Geburtsdatum",
    description: "Personenbeschreibung", triage: "Triage", triageTime: "Sichtungszeit",
    injuries: "Verletzungen", medication: "Medikation/Maßnahmen", unitOnSite: "Einheit vor Ort",
    treatmentArea: "Behandlungsplatz", destinationHospital: "Zielkrankenhaus", physician: "Mediziner",
    hospitalNotes: "Klinische Notizen", notes: "Bemerkungen", treatedOnSite: "Vor Ort behandelt",
    idCheckCode7: "Ausweiskontrolle vor Ort", readyForTransport: "Transportbereit", transported: "Abtransportiert",
    admitted: "Eingeliefert", surgery: "OP", treatedHospital: "Im Krankenhaus behandelt",
    idCheckHospital: "Ausweiskontrolle Krankenhaus", discharged: "Entlassen", triageHistory: "Triage-Verlauf"
  };
  const changed = Array.isArray(entry.changed_fields)
    ? entry.changed_fields.map(field => fieldLabels[field] || field).join(", ")
    : "";
  const displayName = entry.display_name || "Unbekannt";
  const initials = displayName.split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase();
  return `<div class="activity-entry">
    <span class="activity-avatar">${escapeHtml(initials || "?")}</span>
    <div><p><strong>${escapeHtml(displayName)}</strong> ${escapeHtml(actionLabels[entry.action] || "hat eine Änderung vorgenommen")}</p>${changed ? `<small>Geändert: ${escapeHtml(changed)}</small>` : ""}</div>
    <time>${formatDate(entry.created_at)}</time>
  </div>`;
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
  loadActivity();
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
  loadActivity();
});

function showToast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 3000);
}

$("#labForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!$("#labForm").reportValidity() || !currentUser) return;
  const button = $("#saveLabBtn");
  button.disabled = true;
  button.textContent = "Speichert …";
  const id = $("#labEntryId").value;
  const values = {
    patient_name: $("#labPatientName").value.trim(),
    phone: $("#labPhone").value.trim(),
    sample_number: $("#labSampleNumber").value.trim() || null,
    note: $("#labNote").value.trim()
  };
  const result = id
    ? await db.from("lab_requests").update({ ...values, status: "open" }).eq("id", id).eq("status", "open")
    : await db.from("lab_requests").insert({ id: createUuid(), ...values, status: "open" });
  const { error } = result;
  button.disabled = false;
  button.textContent = id ? "Änderungen speichern" : "Request speichern";
  if (error) {
    showToast("Labor Request konnte nicht gespeichert werden.");
    return;
  }
  $("#labDialog").close();
  await loadLabEntries();
  showToast(id ? "Labor Request wurde aktualisiert." : "Labor Request wurde angelegt.");
});

$("#bulletinForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!$("#bulletinForm").reportValidity() || !currentUser) return;
  const button = $("#saveBulletinBtn");
  button.disabled = true;
  button.textContent = "Speichert …";
  const id = $("#bulletinEntryId").value;
  const values = {
    patient_name: $("#bulletinPatientName").value.trim(),
    phone: $("#bulletinPhone").value.trim(),
    concern: $("#bulletinConcern").value.trim()
  };
  const result = id
    ? await db.from("bulletin_entries").update({ ...values, status: "open" }).eq("id", id).eq("status", "open")
    : await db.from("bulletin_entries").insert({ id: createUuid(), ...values, status: "open" });
  const { error } = result;
  button.disabled = false;
  button.textContent = id ? "Änderungen speichern" : "Eintrag speichern";
  if (error) {
    showToast("Eintrag konnte nicht gespeichert werden.");
    return;
  }
  $("#bulletinDialog").close();
  await loadBulletinEntries();
  showToast(id ? "Eintrag wurde aktualisiert." : "Eintrag wurde angelegt.");
});

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
    scene_lead: $("#newIncidentSceneLead").value.trim(),
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
$("#navIncidentsBtn").addEventListener("click", showIncidentOverview);
$("#navBulletinBtn").addEventListener("click", showBulletinBoard);
$("#navLabBtn").addEventListener("click", showLabRequests);
$("#navCollapseBtn").addEventListener("click", () => setNavCollapsed(!$("#appNav").classList.contains("collapsed")));
$("#newBulletinBtn").addEventListener("click", () => openBulletinDialog());
$("#newBulletinMainBtn").addEventListener("click", () => openBulletinDialog());
$("#newLabBtn").addEventListener("click", () => openLabDialog());
$("#newLabMainBtn").addEventListener("click", () => openLabDialog());
$("#closeBulletinDialogBtn").addEventListener("click", () => $("#bulletinDialog").close());
$("#cancelBulletinBtn").addEventListener("click", () => $("#bulletinDialog").close());
$("#closeLabDialogBtn").addEventListener("click", () => $("#labDialog").close());
$("#cancelLabBtn").addEventListener("click", () => $("#labDialog").close());
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
$("#bulletinDialog").addEventListener("click", event => { if (event.target === $("#bulletinDialog")) $("#bulletinDialog").close(); });
$("#labDialog").addEventListener("click", event => { if (event.target === $("#labDialog")) $("#labDialog").close(); });

initialize();
