import { createClient, type User } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Methode nicht erlaubt." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("Authorization") || "";
  if (!supabaseUrl || !serviceRoleKey) return response({ error: "Die Serverkonfiguration ist unvollständig." }, 500);
  if (!authorization.startsWith("Bearer ")) return response({ error: "Nicht angemeldet." }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const token = authorization.slice("Bearer ".length);
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const caller = authData.user;
  if (authError || !caller) return response({ error: "Die Anmeldung ist ungültig oder abgelaufen." }, 401);

  const { data: callerMembership } = await admin
    .from("mci_members")
    .select("can_manage_users")
    .eq("user_id", caller.id)
    .maybeSingle();
  if (!callerMembership?.can_manage_users) return response({ error: "Keine Berechtigung für die Benutzerverwaltung." }, 403);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return response({ error: "Ungültige Anfrage." }, 400);
  }

  const action = cleanText(body.action, 20);
  if (action === "list") {
    const { data: memberships, error: membershipError } = await admin
      .from("mci_members")
      .select("user_id, display_name, can_delete_history, can_manage_users, created_at")
      .order("created_at");
    if (membershipError) return response({ error: "Benutzer konnten nicht geladen werden." }, 500);

    const authUsers: User[] = [];
    let page = 1;
    while (true) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return response({ error: "Kontodaten konnten nicht geladen werden." }, 500);
      authUsers.push(...data.users);
      if (data.users.length < 1000) break;
      page += 1;
    }
    const authById = new Map(authUsers.map((user) => [user.id, user]));
    const users = (memberships || []).map((membership) => {
      const authUser = authById.get(membership.user_id);
      return {
        id: membership.user_id,
        email: authUser?.email || "Unbekannte E-Mail-Adresse",
        display_name: membership.display_name || "",
        can_delete_history: membership.can_delete_history,
        can_manage_users: membership.can_manage_users,
        created_at: membership.created_at,
        last_sign_in_at: authUser?.last_sign_in_at || null,
      };
    });
    return response({ users });
  }

  if (action === "create") {
    const email = cleanText(body.email, 254).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = cleanText(body.displayName, 80);
    if (!email || !email.includes("@") || !displayName || password.length < 8) {
      return response({ error: "E-Mail, Anzeigename und ein Passwort mit mindestens 8 Zeichen sind erforderlich." }, 400);
    }

    let authUser: User | undefined;
    let createdNewAccount = false;
    let searchPage = 1;
    while (!authUser) {
      const { data: existingData, error: searchError } = await admin.auth.admin.listUsers({ page: searchPage, perPage: 1000 });
      if (searchError) return response({ error: "Vorhandene Konten konnten nicht geprüft werden." }, 500);
      authUser = existingData.users.find((user) => user.email?.toLowerCase() === email);
      if (authUser || existingData.users.length < 1000) break;
      searchPage += 1;
    }

    if (authUser) {
      const { data: existingMembership } = await admin.from("mci_members").select("user_id").eq("user_id", authUser.id).maybeSingle();
      if (existingMembership) return response({ error: "Für diese E-Mail-Adresse besteht bereits eine Board-Freigabe." }, 400);
      const { error: updateError } = await admin.auth.admin.updateUserById(authUser.id, {
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      });
      if (updateError) return response({ error: "Das vorhandene Konto konnte nicht reaktiviert werden." }, 400);
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      });
      if (error || !data.user) return response({ error: "Das Benutzerkonto konnte nicht angelegt werden." }, 400);
      authUser = data.user;
      createdNewAccount = true;
    }

    const { error: insertError } = await admin.from("mci_members").insert({
      user_id: authUser.id,
      display_name: displayName,
      can_delete_history: Boolean(body.canDeleteHistory),
      can_manage_users: Boolean(body.canManageUsers),
    });
    if (insertError) {
      if (createdNewAccount) await admin.auth.admin.deleteUser(authUser.id);
      return response({ error: "Die Board-Freigabe konnte nicht angelegt werden." }, 500);
    }
    return response({ ok: true }, 201);
  }

  const userId = cleanText(body.userId, 36);
  if (!userId) return response({ error: "Benutzer-ID fehlt." }, 400);

  const { data: target } = await admin
    .from("mci_members")
    .select("user_id, can_manage_users")
    .eq("user_id", userId)
    .maybeSingle();
  if (!target) return response({ error: "Benutzer wurde nicht gefunden." }, 404);

  if (action === "reset_password") {
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8 || password.length > 256) {
      return response({ error: "Das Passwort muss zwischen 8 und 256 Zeichen lang sein." }, 400);
    }
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) return response({ error: "Das Passwort konnte nicht gesetzt werden." }, 500);
    return response({ ok: true });
  }

  if (action === "update") {
    const displayName = cleanText(body.displayName, 80);
    const nextCanManageUsers = Boolean(body.canManageUsers);
    if (!displayName) return response({ error: "Ein Anzeigename ist erforderlich." }, 400);
    if (userId === caller.id && !nextCanManageUsers) {
      return response({ error: "Die eigene Berechtigung zur Benutzerverwaltung kann nicht entfernt werden." }, 400);
    }
    if (target.can_manage_users && !nextCanManageUsers) {
      const { count } = await admin.from("mci_members").select("user_id", { count: "exact", head: true }).eq("can_manage_users", true);
      if ((count || 0) <= 1) return response({ error: "Mindestens eine Person muss Benutzer verwalten dürfen." }, 400);
    }
    const { error } = await admin.from("mci_members").update({
      display_name: displayName,
      can_delete_history: Boolean(body.canDeleteHistory),
      can_manage_users: nextCanManageUsers,
    }).eq("user_id", userId);
    if (error) return response({ error: "Die Änderungen konnten nicht gespeichert werden." }, 500);
    await admin.auth.admin.updateUserById(userId, { user_metadata: { display_name: displayName } });
    return response({ ok: true });
  }

  if (action === "revoke") {
    if (userId === caller.id) return response({ error: "Der eigene Board-Zugriff kann nicht entzogen werden." }, 400);
    if (target.can_manage_users) {
      const { count } = await admin.from("mci_members").select("user_id", { count: "exact", head: true }).eq("can_manage_users", true);
      if ((count || 0) <= 1) return response({ error: "Der letzten Benutzerverwaltung kann der Zugriff nicht entzogen werden." }, 400);
    }
    const { error } = await admin.from("mci_members").delete().eq("user_id", userId);
    if (error) return response({ error: "Der Zugriff konnte nicht entzogen werden." }, 500);
    return response({ ok: true });
  }

  return response({ error: "Unbekannte Aktion." }, 400);
});
