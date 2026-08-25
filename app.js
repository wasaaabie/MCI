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
let deceasedRecords = [];
let psychologyRecords = [];
let psychologySessions = [];
let currentPsychologyRecord = null;
let currentIncident = null;
let db = null;
let currentUser = null;
let activeUserId = "";
let realtimeChannel = null;
let reloadTimer = null;
let migrationChecked = false;
let toastTimer;
let canDeleteHistory = false;
let canManageUsers = false;
let canAccessPsychology = false;
let managedUsers = [];
let passwordTargetUserId = "";

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
    .select("display_name, can_delete_history, can_manage_users, can_access_psychology")
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
  canDeleteHistory = Boolean(membership.can_delete_history);
  canManageUsers = Boolean(membership.can_manage_users);
  canAccessPsychology = Boolean(membership.can_access_psychology);
  $("#navUsersBtn").classList.toggle("hidden", !canManageUsers);
  $("#navPsychologyBtn").classList.toggle("hidden", !canAccessPsychology);
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
  canDeleteHistory = false;
  canManageUsers = false;
  canAccessPsychology = false;
  managedUsers = [];
  psychologyRecords = [];
  psychologySessions = [];
  currentPsychologyRecord = null;
  bulletinEntries = [];
  labEntries = [];
  deceasedRecords = [];
  $("#authGate").classList.remove("hidden");
  $("#appHeader").classList.add("hidden");
  $("#appNav").classList.add("hidden");
  $("#navUsersBtn").classList.add("hidden");
  $("#navPsychologyBtn").classList.add("hidden");
  $("#userManagementMain").classList.add("hidden");
  $("#psychologyMain").classList.add("hidden");
  $("#psychologyDetailMain").classList.add("hidden");
  $("#bulletinMain").classList.add("hidden");
  $("#labMain").classList.add("hidden");
  $("#deceasedMain").classList.add("hidden");
  $("#incidentMain").classList.add("hidden");
  $("#appMain").classList.add("hidden");
  if (dialog.open) dialog.close();
  if ($("#incidentDialog").open) $("#incidentDialog").close();
  if ($("#bulletinDialog").open) $("#bulletinDialog").close();
  if ($("#labDialog").open) $("#labDialog").close();
  if ($("#deceasedDialog").open) $("#deceasedDialog").close();
  if ($("#passwordDialog").open) $("#passwordDialog").close();
  if ($("#psychologyRecordDialog").open) $("#psychologyRecordDialog").close();
  if ($("#psychologySessionDialog").open) $("#psychologySessionDialog").close();
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
    .on("postgres_changes", { event: "*", schema: "public", table: "deceased_records" }, () => {
      if (!$("#deceasedMain").classList.contains("hidden")) loadDeceasedRecords();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "psychology_records" }, () => {
      if (!$("#psychologyMain").classList.contains("hidden")) loadPsychologyRecords();
      if (currentPsychologyRecord) refreshCurrentPsychologyRecord();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "psychology_sessions" }, payload => {
      if (currentPsychologyRecord && payload.new?.record_id === currentPsychologyRecord.id) loadPsychologySessions();
      if (!$("#psychologyMain").classList.contains("hidden")) loadPsychologyRecords();
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
  document.querySelectorAll('[data-delete-history="incident"]').forEach(button => button.addEventListener("click", () => deleteHistoricalEntry("incident", button.dataset.historyId)));
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
      <div class="history-card-actions"><button class="edit-button" type="button" data-incident-id="${incident.id}">${closed ? "Historie öffnen" : "MCI öffnen"}</button>${closed ? historyDeleteButton("incident", incident.id) : ""}</div>
    </div>
  </article>`;
}

function hidePsychologyViews() {
  $("#psychologyMain").classList.add("hidden");
  $("#psychologyDetailMain").classList.add("hidden");
  currentPsychologyRecord = null;
  psychologySessions = [];
}

function showIncidentOverview() {
  currentIncident = null;
  patients = [];
  activities = [];
  $("#pageTitle").textContent = "MCI Übersicht";
  $("#bulletinMain").classList.add("hidden");
  $("#labMain").classList.add("hidden");
  $("#deceasedMain").classList.add("hidden");
  $("#userManagementMain").classList.add("hidden");
  hidePsychologyViews();
  $("#incidentMain").classList.remove("hidden");
  $("#appMain").classList.add("hidden");
  $("#closeIncidentBtn").classList.add("hidden");
  $("#newPatientBtn").classList.add("hidden");
  $("#newBulletinBtn").classList.add("hidden");
  $("#newLabBtn").classList.add("hidden");
  $("#newDeceasedBtn").classList.add("hidden");
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
  $("#deceasedMain").classList.add("hidden");
  $("#userManagementMain").classList.add("hidden");
  hidePsychologyViews();
  $("#appMain").classList.remove("hidden");
  $("#pageTitle").textContent = incident.title;
  $("#incidentTitle").textContent = incident.title;
  $("#incidentStatusLabel").textContent = closed ? "Abgeschlossene MCI" : "Aktive MCI";
  $("#incidentMeta").textContent = `${incident.location || "Ohne Ortsangabe"} · Scene Lead: ${incident.scene_lead || "Unbekannt"} · Beginn ${formatDate(incident.started_at)}`;
  $("#readOnlyBadge").classList.toggle("hidden", !closed);
  $("#newIncidentBtn").classList.add("hidden");
  $("#newBulletinBtn").classList.add("hidden");
  $("#newLabBtn").classList.add("hidden");
  $("#newDeceasedBtn").classList.add("hidden");
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
  $("#deceasedMain").classList.add("hidden");
  $("#userManagementMain").classList.add("hidden");
  hidePsychologyViews();
  $("#bulletinMain").classList.remove("hidden");
  $("#newIncidentBtn").classList.add("hidden");
  $("#newPatientBtn").classList.add("hidden");
  $("#closeIncidentBtn").classList.add("hidden");
  $("#newBulletinBtn").classList.remove("hidden");
  $("#newLabBtn").classList.add("hidden");
  $("#newDeceasedBtn").classList.add("hidden");
  setActiveNav("bulletin");
  await loadBulletinEntries();
}

function setActiveNav(section) {
  $("#navIncidentsBtn").classList.toggle("active", section === "incidents");
  $("#navBulletinBtn").classList.toggle("active", section === "bulletin");
  $("#navLabBtn").classList.toggle("active", section === "lab");
  $("#navDeceasedBtn").classList.toggle("active", section === "deceased");
  $("#navUsersBtn").classList.toggle("active", section === "users");
  $("#navPsychologyBtn").classList.toggle("active", section === "psychology");
  $("#navIncidentsBtn").setAttribute("aria-current", section === "incidents" ? "page" : "false");
  $("#navBulletinBtn").setAttribute("aria-current", section === "bulletin" ? "page" : "false");
  $("#navLabBtn").setAttribute("aria-current", section === "lab" ? "page" : "false");
  $("#navDeceasedBtn").setAttribute("aria-current", section === "deceased" ? "page" : "false");
  $("#navUsersBtn").setAttribute("aria-current", section === "users" ? "page" : "false");
  $("#navPsychologyBtn").setAttribute("aria-current", section === "psychology" ? "page" : "false");
}

async function callUserManagement(action, payload = {}) {
  const { data, error } = await db.functions.invoke("manage-users", { body: { action, ...payload } });
  if (error) {
    let message = data?.error || error.message || "Die Benutzerverwaltung ist nicht erreichbar.";
    try {
      const details = await error.context?.clone().json();
      if (details?.error) message = details.error;
    } catch (_) {
      // Netzwerk- und CORS-Fehler besitzen nicht immer einen lesbaren Response-Body.
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function showUserManagement() {
  if (!canManageUsers) return;
  currentIncident = null;
  patients = [];
  activities = [];
  $("#pageTitle").textContent = "Benutzerverwaltung";
  ["#incidentMain", "#appMain", "#bulletinMain", "#labMain", "#deceasedMain", "#psychologyMain", "#psychologyDetailMain"].forEach(selector => $(selector).classList.add("hidden"));
  $("#userManagementMain").classList.remove("hidden");
  ["#newIncidentBtn", "#newPatientBtn", "#newBulletinBtn", "#newLabBtn", "#newDeceasedBtn", "#closeIncidentBtn"].forEach(selector => $(selector).classList.add("hidden"));
  setActiveNav("users");
  await loadManagedUsers();
}

async function loadManagedUsers() {
  const body = $("#userManagementBody");
  const errorBox = $("#userManagementError");
  body.innerHTML = `<tr><td class="table-empty" colspan="5">Benutzer werden geladen …</td></tr>`;
  errorBox.classList.add("hidden");
  try {
    const data = await callUserManagement("list");
    managedUsers = data.users || [];
    renderManagedUsers();
  } catch (error) {
    body.innerHTML = `<tr><td class="table-empty" colspan="5">Benutzer konnten nicht geladen werden.</td></tr>`;
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
}

function renderManagedUsers() {
  $("#userCount").textContent = managedUsers.length;
  $("#userManagementBody").innerHTML = managedUsers.length
    ? managedUsers.map(user => {
      const isSelf = user.id === currentUser?.id;
      return `<tr data-managed-user="${user.id}">
        <td><input class="table-text-input" data-user-name value="${escapeHtml(user.display_name || "")}" maxlength="80" aria-label="Anzeigename von ${escapeHtml(user.email)}"></td>
        <td><strong>${escapeHtml(user.email)}</strong></td>
        <td class="bulletin-date">${formatDate(user.last_sign_in_at)}</td>
        <td><div class="user-row-permissions"><label class="check"><input data-user-delete-history type="checkbox" ${user.can_delete_history ? "checked" : ""}><span>Historie löschen</span></label><label class="check"><input data-user-manage-users type="checkbox" ${user.can_manage_users ? "checked" : ""} ${isSelf ? "disabled" : ""}><span>Benutzer verwalten</span></label><label class="check"><input data-user-access-psychology type="checkbox" ${user.can_access_psychology ? "checked" : ""}><span>Psychologie öffnen</span></label></div></td>
        <td><div class="bulletin-actions"><button class="bulletin-edit-button" type="button" data-save-user="${user.id}">Speichern</button><button class="bulletin-edit-button" type="button" data-reset-password="${user.id}">Passwort setzen</button><button class="button-link-danger" type="button" data-revoke-user="${user.id}" ${isSelf ? "disabled title=\"Der eigene Zugriff kann nicht entzogen werden\"" : ""}>Zugriff entziehen</button></div></td>
      </tr>`;
    }).join("")
    : `<tr><td class="table-empty" colspan="5">Keine freigegebenen Benutzer vorhanden.</td></tr>`;
  document.querySelectorAll("[data-save-user]").forEach(button => button.addEventListener("click", () => saveManagedUser(button.dataset.saveUser)));
  document.querySelectorAll("[data-reset-password]").forEach(button => button.addEventListener("click", () => openPasswordDialog(button.dataset.resetPassword)));
  document.querySelectorAll("[data-revoke-user]").forEach(button => button.addEventListener("click", () => revokeManagedUser(button.dataset.revokeUser)));
}

function openPasswordDialog(userId = "") {
  const isOwnPassword = !userId || userId === currentUser?.id;
  const target = managedUsers.find(user => user.id === userId);
  passwordTargetUserId = isOwnPassword ? "" : userId;
  $("#passwordForm").reset();
  $("#passwordDialogTitle").textContent = isOwnPassword ? "Eigenes Passwort ändern" : "Passwort neu setzen";
  $("#passwordDialogText").textContent = isOwnPassword
    ? "Lege ein neues Passwort für dein eigenes Konto fest."
    : `Lege ein neues Passwort für ${target?.display_name || target?.email || "diesen Benutzer"} fest.`;
  $("#passwordDialog").showModal();
  setTimeout(() => $("#newPassword").focus(), 50);
}

async function saveManagedUser(userId) {
  const row = document.querySelector(`[data-managed-user="${userId}"]`);
  if (!row) return;
  const displayName = row.querySelector("[data-user-name]").value.trim();
  if (!displayName) {
    showToast("Bitte einen Anzeigenamen eintragen.");
    return;
  }
  const button = row.querySelector("[data-save-user]");
  button.disabled = true;
  try {
    await callUserManagement("update", {
      userId,
      displayName,
      canDeleteHistory: row.querySelector("[data-user-delete-history]").checked,
      canManageUsers: row.querySelector("[data-user-manage-users]").checked,
      canAccessPsychology: row.querySelector("[data-user-access-psychology]").checked
    });
    await loadManagedUsers();
    showToast("Benutzer und Berechtigungen wurden gespeichert.");
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

async function revokeManagedUser(userId) {
  const user = managedUsers.find(item => item.id === userId);
  if (!user || !confirm(`Board-Zugriff für „${user.display_name || user.email}“ wirklich entziehen?`)) return;
  try {
    await callUserManagement("revoke", { userId });
    await loadManagedUsers();
    showToast("Der Board-Zugriff wurde entzogen.");
  } catch (error) {
    showToast(error.message);
  }
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
    $("#bulletinDepartment").value = entry.department || "";
    $("#bulletinHandledBy").value = entry.handled_by || "";
    $("#bulletinConcern").value = entry.concern;
  }
  $("#bulletinDialog").showModal();
  setTimeout(() => $("#bulletinPatientName").focus(), 50);
}

async function loadBulletinEntries() {
  if (!db || !currentUser) return;
  const { data, error } = await db
    .from("bulletin_entries")
    .select("id, patient_name, phone, department, handled_by, concern, status, created_by_name, created_at, updated_by_name, updated_at, completed_by_name, completed_at")
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
  $("#openBulletinBody").innerHTML = openEntries.length ? openEntries.map(openBulletinRow).join("") : `<tr><td class="table-empty" colspan="8">Keine offenen Einträge vorhanden.</td></tr>`;
  $("#closedBulletinBody").innerHTML = closedEntries.length ? closedEntries.map(closedBulletinRow).join("") : `<tr><td class="table-empty" colspan="9">Noch keine erledigten Einträge vorhanden.</td></tr>`;
  document.querySelectorAll("[data-complete-bulletin]").forEach(button => button.addEventListener("click", () => completeBulletinEntry(button.dataset.completeBulletin)));
  document.querySelectorAll("[data-edit-bulletin]").forEach(button => button.addEventListener("click", () => openBulletinDialog(button.dataset.editBulletin)));
  document.querySelectorAll('[data-delete-history="bulletin"]').forEach(button => button.addEventListener("click", () => deleteHistoricalEntry("bulletin", button.dataset.historyId)));
}

function openBulletinRow(entry) {
  const edited = entry.updated_at ? `<br><small>Bearbeitet von ${escapeHtml(entry.updated_by_name || "Unbekannt")} · ${formatDate(entry.updated_at)}</small>` : "";
  return `<tr><td><strong>${escapeHtml(entry.patient_name)}</strong></td><td>${escapeHtml(entry.department || "–")}</td><td>${escapeHtml(entry.phone)}</td><td class="bulletin-concern">${escapeHtml(entry.concern)}</td><td><strong>${escapeHtml(entry.handled_by || "–")}</strong></td><td><strong>${escapeHtml(entry.created_by_name || "Unbekannt")}</strong>${edited}</td><td class="bulletin-date">${formatDate(entry.created_at)}</td><td><div class="bulletin-actions"><button class="bulletin-edit-button" type="button" data-edit-bulletin="${entry.id}">Bearbeiten</button><button class="complete-button" type="button" data-complete-bulletin="${entry.id}">Erledigt</button></div></td></tr>`;
}

function closedBulletinRow(entry) {
  return `<tr><td><strong>${escapeHtml(entry.patient_name)}</strong></td><td>${escapeHtml(entry.department || "–")}</td><td>${escapeHtml(entry.phone)}</td><td class="bulletin-concern">${escapeHtml(entry.concern)}</td><td><strong>${escapeHtml(entry.handled_by || "–")}</strong></td><td>${escapeHtml(entry.created_by_name || "Unbekannt")}<br><small>${formatDate(entry.created_at)}</small></td><td>${escapeHtml(entry.completed_by_name || "Unbekannt")}</td><td class="bulletin-date">${formatDate(entry.completed_at)}</td><td>${historyDeleteButton("bulletin", entry.id)}</td></tr>`;
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

const psychologyStatusLabels = { active: "Aktiv", paused: "Pausiert", closed: "Abgeschlossen" };

async function showPsychologyOverview() {
  if (!canAccessPsychology) return;
  currentIncident = null;
  currentPsychologyRecord = null;
  psychologySessions = [];
  $("#pageTitle").textContent = "Psychologie";
  ["#incidentMain", "#appMain", "#bulletinMain", "#labMain", "#deceasedMain", "#userManagementMain", "#psychologyDetailMain"].forEach(selector => $(selector).classList.add("hidden"));
  $("#psychologyMain").classList.remove("hidden");
  ["#newIncidentBtn", "#newPatientBtn", "#newBulletinBtn", "#newLabBtn", "#newDeceasedBtn", "#closeIncidentBtn"].forEach(selector => $(selector).classList.add("hidden"));
  setActiveNav("psychology");
  await loadPsychologyRecords();
}

async function loadPsychologyRecords() {
  if (!db || !currentUser || !canAccessPsychology) return;
  const [{ data: records, error }, { data: sessionRefs }] = await Promise.all([
    db.from("psychology_records").select("id, file_number, patient_name, birth_date, phone, treating_staff, general_notes, status, created_by_name, created_at, updated_by_name, updated_at, closed_by_name, closed_at").order("created_at", { ascending: false }),
    db.from("psychology_sessions").select("record_id, session_at").order("session_at", { ascending: false })
  ]);
  if (error) {
    psychologyRecords = [];
    showToast("Psychologie-Akten konnten nicht geladen werden.");
  } else {
    const latestSessions = new Map();
    (sessionRefs || []).forEach(session => { if (!latestSessions.has(session.record_id)) latestSessions.set(session.record_id, session.session_at); });
    psychologyRecords = (records || []).map(record => ({ ...record, last_session_at: latestSessions.get(record.id) || null }));
  }
  renderPsychologyRecords();
}

function renderPsychologyRecords() {
  const search = $("#psychologySearch").value.trim().toLowerCase();
  const status = $("#psychologyStatusFilter").value;
  const visible = psychologyRecords.filter(record => {
    const haystack = `${record.file_number} ${record.patient_name} ${record.treating_staff}`.toLowerCase();
    return (!search || haystack.includes(search)) && (!status || record.status === status);
  });
  $("#psychologyTotalCount").textContent = psychologyRecords.length;
  $("#psychologyActiveCount").textContent = psychologyRecords.filter(record => record.status === "active").length;
  $("#psychologyPausedCount").textContent = psychologyRecords.filter(record => record.status === "paused").length;
  $("#psychologyClosedCount").textContent = psychologyRecords.filter(record => record.status === "closed").length;
  $("#psychologyVisibleCount").textContent = visible.length;
  $("#psychologyRecordsBody").innerHTML = visible.length ? visible.map(record => `<tr>
    <td><strong>${escapeHtml(record.file_number)}</strong></td>
    <td><strong>${escapeHtml(record.patient_name)}</strong><br><small>${record.birth_date ? formatDateOnly(record.birth_date) : "Geburtsdatum unbekannt"}</small></td>
    <td>${escapeHtml(record.treating_staff)}</td>
    <td><span class="psychology-status ${record.status}">${psychologyStatusLabels[record.status] || "Unbekannt"}</span></td>
    <td class="bulletin-date">${record.last_session_at ? formatDate(record.last_session_at) : "Noch keine Sitzung"}</td>
    <td><button class="bulletin-edit-button" type="button" data-open-psychology="${record.id}">Akte öffnen</button></td>
  </tr>`).join("") : `<tr><td class="table-empty" colspan="6">Keine passenden Psychologie-Akten vorhanden.</td></tr>`;
  document.querySelectorAll("[data-open-psychology]").forEach(button => button.addEventListener("click", () => openPsychologyRecord(button.dataset.openPsychology)));
}

function formatDateOnly(value) {
  if (!value) return "–";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? "–" : date.toLocaleDateString("de-DE");
}

async function openPsychologyRecord(id) {
  let record = psychologyRecords.find(item => item.id === id);
  if (!record) {
    const { data } = await db.from("psychology_records").select("*").eq("id", id).maybeSingle();
    record = data;
  }
  if (!record) {
    showToast("Die Psychologie-Akte wurde nicht gefunden.");
    return;
  }
  currentPsychologyRecord = record;
  $("#psychologyMain").classList.add("hidden");
  $("#psychologyDetailMain").classList.remove("hidden");
  $("#pageTitle").textContent = `Akte ${record.file_number}`;
  setActiveNav("psychology");
  renderPsychologyRecordDetail();
  await loadPsychologySessions();
}

async function refreshCurrentPsychologyRecord() {
  if (!currentPsychologyRecord || !canAccessPsychology) return;
  const { data } = await db.from("psychology_records").select("*").eq("id", currentPsychologyRecord.id).maybeSingle();
  if (!data) {
    showPsychologyOverview();
    return;
  }
  currentPsychologyRecord = data;
  renderPsychologyRecordDetail();
}

function renderPsychologyRecordDetail() {
  const record = currentPsychologyRecord;
  if (!record) return;
  const closed = record.status === "closed";
  $("#psychologyRecordStatusLabel").textContent = psychologyStatusLabels[record.status] || "Psychologie-Akte";
  $("#psychologyRecordTitle").textContent = record.patient_name;
  $("#psychologyRecordMeta").textContent = `Akte ${record.file_number} · Angelegt von ${record.created_by_name || "Unbekannt"} am ${formatDate(record.created_at)}`;
  $("#psychologyRecordStaff").textContent = record.treating_staff || "–";
  $("#psychologyRecordPhone").textContent = record.phone || "–";
  $("#psychologyRecordBirthDate").textContent = formatDateOnly(record.birth_date);
  $("#psychologyRecordNotes").textContent = record.general_notes || "Keine allgemeinen Anmerkungen.";
  $("#psychologyReadOnlyBadge").classList.toggle("hidden", !closed);
  $("#editPsychologyRecordBtn").classList.toggle("hidden", closed);
  $("#newPsychologySessionBtn").classList.toggle("hidden", closed);
  $("#deletePsychologyRecordBtn").classList.toggle("hidden", !(closed && canDeleteHistory));
}

function openPsychologyRecordDialog(id = "") {
  const record = psychologyRecords.find(item => item.id === id) || (currentPsychologyRecord?.id === id ? currentPsychologyRecord : null);
  $("#psychologyRecordForm").reset();
  $("#psychologyRecordId").value = record?.id || "";
  $("#psychologyRecordDialogTitle").textContent = record ? "Patientenakte bearbeiten" : "Patientenakte anlegen";
  $("#psychologyRecordStatus").querySelector('option[value="closed"]').disabled = !record;
  if (record) {
    $("#psychologyFileNumber").value = record.file_number;
    $("#psychologyPatientName").value = record.patient_name;
    $("#psychologyBirthDate").value = record.birth_date || "";
    $("#psychologyPhone").value = record.phone || "";
    $("#psychologyTreatingStaff").value = record.treating_staff;
    $("#psychologyRecordStatus").value = record.status;
    $("#psychologyGeneralNotes").value = record.general_notes || "";
  }
  setPsychologyCloseWarning();
  $("#psychologyRecordDialog").showModal();
  setTimeout(() => $("#psychologyFileNumber").focus(), 50);
}

function setPsychologyCloseWarning() {
  const existing = Boolean($("#psychologyRecordId").value);
  $("#psychologyCloseWarning").classList.toggle("hidden", !existing || $("#psychologyRecordStatus").value !== "closed");
}

async function loadPsychologySessions() {
  if (!currentPsychologyRecord) return;
  const { data, error } = await db.from("psychology_sessions").select("*").eq("record_id", currentPsychologyRecord.id).order("session_at", { ascending: false });
  psychologySessions = error ? [] : (data || []);
  if (error) showToast("Sitzungsverlauf konnte nicht geladen werden.");
  renderPsychologySessions();
}

function renderPsychologySessions() {
  $("#psychologySessionCount").textContent = psychologySessions.length;
  const editable = currentPsychologyRecord?.status !== "closed";
  $("#psychologySessionList").innerHTML = psychologySessions.length ? psychologySessions.map(session => {
    const updated = session.updated_at ? ` · bearbeitet von ${escapeHtml(session.updated_by_name || "Unbekannt")} am ${formatDate(session.updated_at)}` : "";
    return `<article class="psychology-session-card">
      <div class="psychology-session-heading"><div><p class="eyebrow">${formatDate(session.session_at)}</p><h3>${escapeHtml(session.reason)}</h3></div>${editable ? `<button class="bulletin-edit-button" type="button" data-edit-psychology-session="${session.id}">Bearbeiten</button>` : ""}</div>
      <div class="psychology-session-meta"><span>Behandelnde Person</span><strong>${escapeHtml(session.treating_staff)}</strong></div>
      <div class="psychology-session-content"><div><span>Gesprächsnotizen / Verlauf</span><p>${formatMultiline(session.notes)}</p></div>${session.assessment ? `<div><span>Einschätzung / Befund</span><p>${formatMultiline(session.assessment)}</p></div>` : ""}${session.measures ? `<div><span>Vereinbarte Maßnahmen</span><p>${formatMultiline(session.measures)}</p></div>` : ""}${session.internal_note ? `<div class="internal-note"><span>Vertraulicher interner Vermerk</span><p>${formatMultiline(session.internal_note)}</p></div>` : ""}</div>
      <footer><span>Nächster Termin: ${session.next_appointment ? formatDate(session.next_appointment) : "nicht festgelegt"}</span><small>Dokumentiert von ${escapeHtml(session.created_by_name || "Unbekannt")} am ${formatDate(session.created_at)}${updated}</small></footer>
    </article>`;
  }).join("") : `<div class="activity-empty">Für diese Akte wurden noch keine Sitzungen dokumentiert.</div>`;
  document.querySelectorAll("[data-edit-psychology-session]").forEach(button => button.addEventListener("click", () => openPsychologySessionDialog(button.dataset.editPsychologySession)));
}

function formatMultiline(value) {
  return escapeHtml(value || "").replace(/\n/g, "<br>");
}

function openPsychologySessionDialog(id = "") {
  if (!currentPsychologyRecord || currentPsychologyRecord.status === "closed") return;
  const session = psychologySessions.find(item => item.id === id);
  $("#psychologySessionForm").reset();
  $("#psychologySessionId").value = session?.id || "";
  $("#psychologySessionDialogTitle").textContent = session ? "Sitzung bearbeiten" : "Sitzung dokumentieren";
  $("#psychologySessionAt").value = localDateTimeValue(session?.session_at ? new Date(session.session_at) : new Date());
  $("#psychologySessionStaff").value = session?.treating_staff || currentPsychologyRecord.treating_staff || "";
  $("#psychologySessionReason").value = session?.reason || "";
  $("#psychologySessionNotes").value = session?.notes || "";
  $("#psychologySessionAssessment").value = session?.assessment || "";
  $("#psychologySessionMeasures").value = session?.measures || "";
  $("#psychologyNextAppointment").value = session?.next_appointment ? localDateTimeValue(new Date(session.next_appointment)) : "";
  $("#psychologyInternalNote").value = session?.internal_note || "";
  $("#psychologySessionDialog").showModal();
}

async function deleteCurrentPsychologyRecord() {
  const record = currentPsychologyRecord;
  if (!record || record.status !== "closed" || !canDeleteHistory) return;
  if (!confirm(`Psychologie-Akte „${record.file_number} – ${record.patient_name}“ einschließlich aller Sitzungen endgültig löschen? Dieser Vorgang ist unwiderruflich.`)) return;
  const { error } = await db.rpc("delete_history_entry", { p_entry_type: "psychology", p_entry_id: record.id });
  if (error) {
    showToast("Die Psychologie-Akte konnte nicht gelöscht werden.");
    return;
  }
  currentPsychologyRecord = null;
  await showPsychologyOverview();
  showToast("Die Psychologie-Akte wurde endgültig gelöscht.");
}

async function showLabRequests() {
  currentIncident = null;
  patients = [];
  activities = [];
  $("#pageTitle").textContent = "Labor Requests";
  $("#incidentMain").classList.add("hidden");
  $("#appMain").classList.add("hidden");
  $("#bulletinMain").classList.add("hidden");
  $("#deceasedMain").classList.add("hidden");
  $("#userManagementMain").classList.add("hidden");
  hidePsychologyViews();
  $("#labMain").classList.remove("hidden");
  $("#newIncidentBtn").classList.add("hidden");
  $("#newPatientBtn").classList.add("hidden");
  $("#newBulletinBtn").classList.add("hidden");
  $("#closeIncidentBtn").classList.add("hidden");
  $("#newLabBtn").classList.remove("hidden");
  $("#newDeceasedBtn").classList.add("hidden");
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
  $("#closedLabBody").innerHTML = closedEntries.length ? closedEntries.map(closedLabRow).join("") : `<tr><td class="table-empty" colspan="8">Noch keine erledigten Labor Requests vorhanden.</td></tr>`;
  document.querySelectorAll("[data-complete-lab]").forEach(button => button.addEventListener("click", () => completeLabEntry(button.dataset.completeLab)));
  document.querySelectorAll("[data-edit-lab]").forEach(button => button.addEventListener("click", () => openLabDialog(button.dataset.editLab)));
  document.querySelectorAll('[data-delete-history="lab"]').forEach(button => button.addEventListener("click", () => deleteHistoricalEntry("lab", button.dataset.historyId)));
}

function openLabRow(entry) {
  const edited = entry.updated_at ? `<br><small>Bearbeitet von ${escapeHtml(entry.updated_by_name || "Unbekannt")} · ${formatDate(entry.updated_at)}</small>` : "";
  return `<tr><td><strong>${escapeHtml(entry.patient_name)}</strong></td><td>${escapeHtml(entry.phone)}</td><td>${escapeHtml(entry.sample_number || "–")}</td><td class="bulletin-concern">${escapeHtml(entry.note)}</td><td><strong>${escapeHtml(entry.created_by_name || "Unbekannt")}</strong>${edited}</td><td class="bulletin-date">${formatDate(entry.created_at)}</td><td><div class="bulletin-actions"><button class="bulletin-edit-button" type="button" data-edit-lab="${entry.id}">Bearbeiten</button><button class="complete-button" type="button" data-complete-lab="${entry.id}">Erledigt</button></div></td></tr>`;
}

function closedLabRow(entry) {
  return `<tr><td><strong>${escapeHtml(entry.patient_name)}</strong></td><td>${escapeHtml(entry.phone)}</td><td>${escapeHtml(entry.sample_number || "–")}</td><td class="bulletin-concern">${escapeHtml(entry.note)}</td><td>${escapeHtml(entry.created_by_name || "Unbekannt")}<br><small>${formatDate(entry.created_at)}</small></td><td>${escapeHtml(entry.completed_by_name || "Unbekannt")}</td><td class="bulletin-date">${formatDate(entry.completed_at)}</td><td>${historyDeleteButton("lab", entry.id)}</td></tr>`;
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

async function showDeceasedOverview() {
  currentIncident = null;
  patients = [];
  activities = [];
  $("#pageTitle").textContent = "Totenübersicht";
  $("#incidentMain").classList.add("hidden");
  $("#appMain").classList.add("hidden");
  $("#bulletinMain").classList.add("hidden");
  $("#labMain").classList.add("hidden");
  $("#userManagementMain").classList.add("hidden");
  hidePsychologyViews();
  $("#deceasedMain").classList.remove("hidden");
  $("#newIncidentBtn").classList.add("hidden");
  $("#newPatientBtn").classList.add("hidden");
  $("#newBulletinBtn").classList.add("hidden");
  $("#newLabBtn").classList.add("hidden");
  $("#closeIncidentBtn").classList.add("hidden");
  $("#newDeceasedBtn").classList.remove("hidden");
  setActiveNav("deceased");
  await loadDeceasedRecords();
}

function populateChamberOptions(currentId = "") {
  const occupied = new Map(deceasedRecords
    .filter(record => record.chamber_occupied && record.id !== currentId)
    .map(record => [Number(record.chamber_number), record.patient_name]));
  $("#deceasedChamberNumber").innerHTML = `<option value="">Fach auswählen</option>${Array.from({ length: 16 }, (_, index) => {
    const number = index + 1;
    const patient = occupied.get(number);
    return `<option value="${number}"${patient ? " disabled" : ""}>Fach ${String(number).padStart(2, "0")}${patient ? ` · belegt (${escapeHtml(patient)})` : " · frei"}</option>`;
  }).join("")}`;
}

function setDeceasedChamberState() {
  const occupied = $("#deceasedChamberOccupied").checked;
  const select = $("#deceasedChamberNumber");
  select.disabled = !occupied;
  select.required = occupied;
  if (!occupied) select.value = "";
}

function setAutopsyReportState() {
  const checked = $("#deceasedAutopsyReport").checked;
  if (checked) $("#deceasedAutopsyApproved").checked = true;
  $("#autopsyArchiveWarning").classList.toggle("hidden", !checked);
  $("#saveDeceasedBtn").textContent = checked
    ? "Bericht bestätigen & archivieren"
    : ($("#deceasedEntryId").value ? "Änderungen speichern" : "Person speichern");
}

function openDeceasedDialog(id = "", preferredChamber = null) {
  $("#deceasedForm").reset();
  $("#deceasedEntryId").value = id;
  const record = deceasedRecords.find(item => item.id === id);
  populateChamberOptions(id);
  $("#deceasedDialogTitle").textContent = record ? "Eintrag bearbeiten" : "Person erfassen";
  $("#saveDeceasedBtn").textContent = record ? "Änderungen speichern" : "Person speichern";
  $("#releaseChamberBtn").classList.toggle("hidden", !record?.chamber_occupied);
  $("#releaseChamberBtn").textContent = record?.chamber_number ? `Fach ${String(record.chamber_number).padStart(2, "0")} leeren` : "Kühlfach leeren";
  if (record) {
    $("#deceasedPatientName").value = record.patient_name;
    $("#deceasedDateOfDeath").value = record.date_of_death;
    $("#deceasedCircumstances").value = record.suspected_circumstances;
    $("#deceasedContactInfo").value = record.contact_information || "";
    $("#deceasedBurialDate").value = record.burial_date || "";
    $("#deceasedAutopsyApproved").checked = Boolean(record.autopsy_approved);
    $("#deceasedAutopsyReport").checked = Boolean(record.autopsy_report);
    $("#deceasedChamberOccupied").checked = Boolean(record.chamber_occupied);
    $("#deceasedChamberNumber").value = record.chamber_number ? String(record.chamber_number) : "";
  } else {
    $("#deceasedDateOfDeath").value = localDateValue(new Date());
    if (preferredChamber) {
      $("#deceasedChamberOccupied").checked = true;
      $("#deceasedChamberNumber").value = String(preferredChamber);
    }
  }
  setDeceasedChamberState();
  setAutopsyReportState();
  $("#deceasedDialog").showModal();
  setTimeout(() => $("#deceasedPatientName").focus(), 50);
}

async function loadDeceasedRecords() {
  if (!db || !currentUser) return;
  const { data, error } = await db
    .from("deceased_records")
    .select("id, patient_name, date_of_death, suspected_circumstances, contact_information, burial_date, autopsy_approved, autopsy_report, chamber_occupied, chamber_number, created_by_name, created_at, updated_by_name, updated_at")
    .order("date_of_death", { ascending: false });
  deceasedRecords = error ? [] : (data || []);
  if (error) showToast("Totenübersicht konnte nicht geladen werden.");
  renderDeceasedRecords();
}

async function releaseDeceasedChamber() {
  const id = $("#deceasedEntryId").value;
  const record = deceasedRecords.find(item => item.id === id);
  if (!record?.chamber_occupied || !record.chamber_number) return;
  const chamberLabel = `Fach ${String(record.chamber_number).padStart(2, "0")}`;
  if (!confirm(`${chamberLabel} von „${record.patient_name}“ wirklich leeren? Der Personeneintrag bleibt erhalten.`)) return;
  const button = $("#releaseChamberBtn");
  button.disabled = true;
  button.textContent = "Wird geleert …";
  const { error } = await db.from("deceased_records").update({ chamber_occupied: false, chamber_number: null }).eq("id", id);
  button.disabled = false;
  if (error) {
    button.textContent = `${chamberLabel} leeren`;
    showToast("Kühlfach konnte nicht geleert werden.");
    return;
  }
  $("#deceasedDialog").close();
  await loadDeceasedRecords();
  showToast(`${chamberLabel} wurde geleert. Der Personeneintrag bleibt erhalten.`);
}

function renderDeceasedRecords() {
  const activeRecords = deceasedRecords.filter(record => !record.autopsy_report);
  const historyRecords = deceasedRecords.filter(record => record.autopsy_report)
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  const occupiedRecords = activeRecords.filter(record => record.chamber_occupied && record.chamber_number);
  const occupiedByChamber = new Map(occupiedRecords.map(record => [Number(record.chamber_number), record]));
  $("#deceasedTotalCount").textContent = activeRecords.length;
  $("#deceasedOccupiedCount").textContent = occupiedRecords.length;
  $("#deceasedFreeCount").textContent = Math.max(0, 16 - occupiedRecords.length);
  $("#deceasedPendingReportsCount").textContent = activeRecords.filter(record => record.autopsy_approved).length;
  $("#deceasedHistoryCount").textContent = historyRecords.length;
  $("#chamberGrid").innerHTML = Array.from({ length: 16 }, (_, index) => {
    const number = index + 1;
    const record = occupiedByChamber.get(number);
    return record
      ? `<button class="chamber-card occupied" type="button" data-edit-deceased="${record.id}" title="Eintrag von ${escapeHtml(record.patient_name)} öffnen"><span>Fach ${String(number).padStart(2, "0")}</span><strong>${escapeHtml(record.patient_name)}</strong><small>seit ${formatCalendarDate(record.date_of_death)}</small></button>`
      : `<button class="chamber-card" type="button" data-new-deceased-chamber="${number}" title="Person direkt in Fach ${number} erfassen"><span>Fach ${String(number).padStart(2, "0")}</span><strong>Frei</strong><small>anklicken zum Belegen</small></button>`;
  }).join("");
  $("#deceasedBody").innerHTML = activeRecords.length
    ? activeRecords.map(deceasedTableRow).join("")
    : `<tr><td class="table-empty" colspan="8">Keine aktiven Einträge vorhanden.</td></tr>`;
  $("#deceasedHistoryBody").innerHTML = historyRecords.length
    ? historyRecords.map(deceasedHistoryTableRow).join("")
    : `<tr><td class="table-empty" colspan="8">Noch keine abgeschlossenen Einträge vorhanden.</td></tr>`;
  document.querySelectorAll("[data-edit-deceased]").forEach(button => button.addEventListener("click", () => openDeceasedDialog(button.dataset.editDeceased)));
  document.querySelectorAll("[data-new-deceased-chamber]").forEach(button => button.addEventListener("click", () => openDeceasedDialog("", Number(button.dataset.newDeceasedChamber))));
  document.querySelectorAll('[data-delete-history="deceased"]').forEach(button => button.addEventListener("click", () => deleteHistoricalEntry("deceased", button.dataset.historyId)));
}

function deceasedTableRow(record) {
  const audit = record.updated_at
    ? `Bearbeitet von ${escapeHtml(record.updated_by_name || "Unbekannt")} · ${formatDate(record.updated_at)}`
    : `Erfasst von ${escapeHtml(record.created_by_name || "Unbekannt")} · ${formatDate(record.created_at)}`;
  const approval = record.autopsy_approved
    ? `<span class="record-chip done">Obduktion freigegeben</span>`
    : `<span class="record-chip waiting">Freigabe ausstehend</span>`;
  const report = record.autopsy_report
    ? `<span class="record-chip done">Bericht vorhanden</span>`
    : `<span class="record-chip">Kein Bericht</span>`;
  const chamber = record.chamber_occupied && record.chamber_number
    ? `<span class="chamber-badge">Fach ${String(record.chamber_number).padStart(2, "0")}</span>`
    : `<span class="chamber-badge free">Kein Fach</span>`;
  return `<tr><td><strong>${escapeHtml(record.patient_name)}</strong><small>${audit}</small></td><td class="bulletin-date">${formatCalendarDate(record.date_of_death)}</td><td>${escapeHtml(record.suspected_circumstances)}</td><td>${escapeHtml(record.contact_information || "–")}</td><td class="bulletin-date">${formatCalendarDate(record.burial_date)}</td><td><div class="deceased-status">${approval}${report}</div></td><td>${chamber}</td><td><button class="bulletin-edit-button" type="button" data-edit-deceased="${record.id}">Bearbeiten</button></td></tr>`;
}

function deceasedHistoryTableRow(record) {
  const completedBy = record.updated_by_name || record.created_by_name || "Unbekannt";
  const completedAt = record.updated_at || record.created_at;
  return `<tr><td><strong>${escapeHtml(record.patient_name)}</strong><small>Obduktionsbericht vorhanden</small></td><td class="bulletin-date">${formatCalendarDate(record.date_of_death)}</td><td>${escapeHtml(record.suspected_circumstances)}</td><td>${escapeHtml(record.contact_information || "–")}</td><td class="bulletin-date">${formatCalendarDate(record.burial_date)}</td><td>${escapeHtml(completedBy)}</td><td class="bulletin-date">${formatDate(completedAt)}</td><td>${historyDeleteButton("deceased", record.id)}</td></tr>`;
}

function historyDeleteButton(type, id) {
  return canDeleteHistory
    ? `<button class="history-delete-button" type="button" data-delete-history="${type}" data-history-id="${id}">Endgültig löschen</button>`
    : "";
}

async function deleteHistoricalEntry(type, id) {
  if (!canDeleteHistory || !db) return;
  const sources = {
    incident: incidents,
    bulletin: bulletinEntries,
    lab: labEntries,
    deceased: deceasedRecords
  };
  const entry = sources[type]?.find(item => item.id === id);
  const label = entry?.title || entry?.patient_name || "dieser Eintrag";
  const incidentWarning = type === "incident" ? " Dabei werden auch alle Patienten- und Protokolldaten dieser MCI gelöscht." : "";
  if (!confirm(`„${label}“ wirklich endgültig aus der Historie löschen?${incidentWarning} Dieser Vorgang ist unwiderruflich.`)) return;
  const { error } = await db.rpc("delete_history_entry", { p_entry_type: type, p_entry_id: id });
  if (error) {
    showToast("Historieneintrag konnte nicht gelöscht werden. Recht und Datenbankversion prüfen.");
    return;
  }
  if (type === "incident") await loadIncidents();
  if (type === "bulletin") await loadBulletinEntries();
  if (type === "lab") await loadLabEntries();
  if (type === "deceased") await loadDeceasedRecords();
  showToast("Historieneintrag wurde endgültig gelöscht.");
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

function formatCalendarDate(value) {
  if (!value) return "–";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "–" : date.toLocaleDateString("de-DE", { dateStyle: "medium" });
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

function localDateValue(date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
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

$("#psychologyRecordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const recordForm = event.currentTarget;
  if (!recordForm.reportValidity() || !currentUser || !canAccessPsychology) return;
  const id = $("#psychologyRecordId").value;
  const values = {
    file_number: $("#psychologyFileNumber").value.trim(),
    patient_name: $("#psychologyPatientName").value.trim(),
    birth_date: $("#psychologyBirthDate").value || null,
    phone: $("#psychologyPhone").value.trim() || null,
    treating_staff: $("#psychologyTreatingStaff").value.trim(),
    general_notes: $("#psychologyGeneralNotes").value.trim() || null,
    status: id ? $("#psychologyRecordStatus").value : "active"
  };
  const button = $("#savePsychologyRecordBtn");
  button.disabled = true;
  button.textContent = "Wird gespeichert …";
  const result = id
    ? await db.from("psychology_records").update(values).eq("id", id).select("id").single()
    : await db.from("psychology_records").insert({ id: createUuid(), ...values }).select("id").single();
  button.disabled = false;
  button.textContent = "Akte speichern";
  if (result.error) {
    showToast(result.error.code === "23505" ? "Diese Aktennummer wird bereits verwendet." : "Die Psychologie-Akte konnte nicht gespeichert werden.");
    return;
  }
  $("#psychologyRecordDialog").close();
  await loadPsychologyRecords();
  await openPsychologyRecord(result.data.id);
  showToast(id ? "Psychologie-Akte wurde aktualisiert." : "Psychologie-Akte wurde angelegt.");
});

$("#psychologySessionForm").addEventListener("submit", async event => {
  event.preventDefault();
  const sessionForm = event.currentTarget;
  if (!sessionForm.reportValidity() || !currentPsychologyRecord || currentPsychologyRecord.status === "closed") return;
  const id = $("#psychologySessionId").value;
  const values = {
    record_id: currentPsychologyRecord.id,
    session_at: new Date($("#psychologySessionAt").value).toISOString(),
    treating_staff: $("#psychologySessionStaff").value.trim(),
    reason: $("#psychologySessionReason").value.trim(),
    notes: $("#psychologySessionNotes").value.trim(),
    assessment: $("#psychologySessionAssessment").value.trim() || null,
    measures: $("#psychologySessionMeasures").value.trim() || null,
    next_appointment: $("#psychologyNextAppointment").value ? new Date($("#psychologyNextAppointment").value).toISOString() : null,
    internal_note: $("#psychologyInternalNote").value.trim() || null
  };
  const button = $("#savePsychologySessionBtn");
  button.disabled = true;
  button.textContent = "Wird gespeichert …";
  const result = id
    ? await db.from("psychology_sessions").update(values).eq("id", id)
    : await db.from("psychology_sessions").insert({ id: createUuid(), ...values });
  button.disabled = false;
  button.textContent = "Sitzung speichern";
  if (result.error) {
    showToast("Die Sitzung konnte nicht gespeichert werden.");
    return;
  }
  $("#psychologySessionDialog").close();
  await loadPsychologySessions();
  showToast(id ? "Sitzung wurde aktualisiert." : "Sitzung wurde dokumentiert.");
});

$("#deceasedForm").addEventListener("submit", async event => {
  event.preventDefault();
  setDeceasedChamberState();
  if (!$("#deceasedForm").reportValidity() || !currentUser) return;
  const id = $("#deceasedEntryId").value;
  const autopsyReport = $("#deceasedAutopsyReport").checked;
  const chamberOccupied = $("#deceasedChamberOccupied").checked;
  const chamberNumber = chamberOccupied ? Number($("#deceasedChamberNumber").value) : null;
  const chamberConflict = !autopsyReport && chamberOccupied && deceasedRecords.some(record => record.id !== id && record.chamber_occupied && Number(record.chamber_number) === chamberNumber);
  if (chamberConflict) {
    showToast(`Kühlfach ${String(chamberNumber).padStart(2, "0")} ist bereits belegt.`);
    return;
  }
  if (autopsyReport && !confirm("Obduktionsbericht wirklich bestätigen? Die Person wird dauerhaft in die Historie verschoben und das zugehörige Kühlfach automatisch geleert.")) return;
  const button = $("#saveDeceasedBtn");
  button.disabled = true;
  button.textContent = "Speichert …";
  const values = {
    patient_name: $("#deceasedPatientName").value.trim(),
    date_of_death: $("#deceasedDateOfDeath").value,
    suspected_circumstances: $("#deceasedCircumstances").value.trim(),
    contact_information: $("#deceasedContactInfo").value.trim() || null,
    burial_date: $("#deceasedBurialDate").value || null,
    autopsy_approved: $("#deceasedAutopsyApproved").checked || autopsyReport,
    autopsy_report: autopsyReport,
    chamber_occupied: autopsyReport ? false : chamberOccupied,
    chamber_number: autopsyReport ? null : chamberNumber
  };
  const result = id
    ? await db.from("deceased_records").update(values).eq("id", id)
    : await db.from("deceased_records").insert({ id: createUuid(), ...values });
  const { error } = result;
  button.disabled = false;
  setAutopsyReportState();
  if (error) {
    showToast(error.code === "23505" ? "Das gewählte Kühlfach wurde zwischenzeitlich belegt." : "Eintrag konnte nicht gespeichert werden.");
    return;
  }
  $("#deceasedDialog").close();
  await loadDeceasedRecords();
  showToast(autopsyReport ? "Eintrag wurde abgeschlossen, archiviert und das Kühlfach geleert." : (id ? "Eintrag wurde aktualisiert." : "Person wurde in der Totenübersicht erfasst."));
});

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
    department: $("#bulletinDepartment").value.trim(),
    handled_by: $("#bulletinHandledBy").value.trim(),
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

$("#createUserForm").addEventListener("submit", async event => {
  event.preventDefault();
  const createForm = event.currentTarget;
  if (!createForm.reportValidity() || !canManageUsers) return;
  const button = $("#createUserBtn");
  button.disabled = true;
  button.textContent = "Konto wird angelegt …";
  try {
    await callUserManagement("create", {
      email: $("#newUserEmail").value.trim(),
      password: $("#newUserPassword").value,
      displayName: $("#newUserDisplayName").value.trim(),
      canDeleteHistory: $("#newUserCanDeleteHistory").checked,
      canManageUsers: $("#newUserCanManageUsers").checked,
      canAccessPsychology: $("#newUserCanAccessPsychology").checked
    });
    createForm.reset();
    await loadManagedUsers();
    showToast("Das Benutzerkonto wurde angelegt.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Konto anlegen";
  }
});

$("#passwordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const passwordForm = event.currentTarget;
  if (!passwordForm.reportValidity()) return;
  const password = $("#newPassword").value;
  if (password !== $("#confirmNewPassword").value) {
    showToast("Die eingegebenen Passwörter stimmen nicht überein.");
    return;
  }
  const button = $("#savePasswordBtn");
  button.disabled = true;
  button.textContent = "Wird gespeichert …";
  try {
    if (passwordTargetUserId) {
      if (!canManageUsers) throw new Error("Keine Berechtigung zum Setzen fremder Passwörter.");
      await callUserManagement("reset_password", { userId: passwordTargetUserId, password });
    } else {
      const { error } = await db.auth.updateUser({ password });
      if (error) throw new Error("Das eigene Passwort konnte nicht geändert werden. Bitte melde dich neu an und versuche es erneut.");
    }
    $("#passwordDialog").close();
    passwordForm.reset();
    passwordTargetUserId = "";
    showToast("Das Passwort wurde erfolgreich geändert.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Passwort speichern";
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  if (db) await db.auth.signOut();
});
$("#changeOwnPasswordBtn").addEventListener("click", () => openPasswordDialog());
$("#newIncidentBtn").addEventListener("click", openIncidentDialog);
$("#newIncidentMainBtn").addEventListener("click", openIncidentDialog);
$("#navIncidentsBtn").addEventListener("click", showIncidentOverview);
$("#navBulletinBtn").addEventListener("click", showBulletinBoard);
$("#navLabBtn").addEventListener("click", showLabRequests);
$("#navDeceasedBtn").addEventListener("click", showDeceasedOverview);
$("#navPsychologyBtn").addEventListener("click", showPsychologyOverview);
$("#navUsersBtn").addEventListener("click", showUserManagement);
$("#navCollapseBtn").addEventListener("click", () => setNavCollapsed(!$("#appNav").classList.contains("collapsed")));
$("#newBulletinBtn").addEventListener("click", () => openBulletinDialog());
$("#newBulletinMainBtn").addEventListener("click", () => openBulletinDialog());
$("#newLabBtn").addEventListener("click", () => openLabDialog());
$("#newLabMainBtn").addEventListener("click", () => openLabDialog());
$("#newDeceasedBtn").addEventListener("click", () => openDeceasedDialog());
$("#newDeceasedMainBtn").addEventListener("click", () => openDeceasedDialog());
$("#newPsychologyRecordBtn").addEventListener("click", () => openPsychologyRecordDialog());
$("#backToPsychologyBtn").addEventListener("click", showPsychologyOverview);
$("#editPsychologyRecordBtn").addEventListener("click", () => openPsychologyRecordDialog(currentPsychologyRecord?.id || ""));
$("#newPsychologySessionBtn").addEventListener("click", () => openPsychologySessionDialog());
$("#deletePsychologyRecordBtn").addEventListener("click", deleteCurrentPsychologyRecord);
$("#closeBulletinDialogBtn").addEventListener("click", () => $("#bulletinDialog").close());
$("#cancelBulletinBtn").addEventListener("click", () => $("#bulletinDialog").close());
$("#closeLabDialogBtn").addEventListener("click", () => $("#labDialog").close());
$("#cancelLabBtn").addEventListener("click", () => $("#labDialog").close());
$("#closeDeceasedDialogBtn").addEventListener("click", () => $("#deceasedDialog").close());
$("#cancelDeceasedBtn").addEventListener("click", () => $("#deceasedDialog").close());
$("#closePsychologyRecordDialogBtn").addEventListener("click", () => $("#psychologyRecordDialog").close());
$("#cancelPsychologyRecordBtn").addEventListener("click", () => $("#psychologyRecordDialog").close());
$("#closePsychologySessionDialogBtn").addEventListener("click", () => $("#psychologySessionDialog").close());
$("#cancelPsychologySessionBtn").addEventListener("click", () => $("#psychologySessionDialog").close());
$("#closePasswordDialogBtn").addEventListener("click", () => $("#passwordDialog").close());
$("#cancelPasswordBtn").addEventListener("click", () => $("#passwordDialog").close());
$("#releaseChamberBtn").addEventListener("click", releaseDeceasedChamber);
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
$("#deceasedChamberOccupied").addEventListener("change", setDeceasedChamberState);
$("#deceasedAutopsyReport").addEventListener("change", setAutopsyReportState);
$("#psychologySearch").addEventListener("input", renderPsychologyRecords);
$("#psychologyStatusFilter").addEventListener("change", renderPsychologyRecords);
$("#psychologyRecordStatus").addEventListener("change", setPsychologyCloseWarning);
dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
$("#incidentDialog").addEventListener("click", event => { if (event.target === $("#incidentDialog")) $("#incidentDialog").close(); });
$("#bulletinDialog").addEventListener("click", event => { if (event.target === $("#bulletinDialog")) $("#bulletinDialog").close(); });
$("#labDialog").addEventListener("click", event => { if (event.target === $("#labDialog")) $("#labDialog").close(); });
$("#deceasedDialog").addEventListener("click", event => { if (event.target === $("#deceasedDialog")) $("#deceasedDialog").close(); });
$("#passwordDialog").addEventListener("click", event => { if (event.target === $("#passwordDialog")) $("#passwordDialog").close(); });
$("#psychologyRecordDialog").addEventListener("click", event => { if (event.target === $("#psychologyRecordDialog")) $("#psychologyRecordDialog").close(); });
$("#psychologySessionDialog").addEventListener("click", event => { if (event.target === $("#psychologySessionDialog")) $("#psychologySessionDialog").close(); });

initialize();
