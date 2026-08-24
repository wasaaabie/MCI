# MCI Board

Geschütztes, gemeinsames Einsatzboard für ein RP-Projekt. Die Website kann auf GitHub Pages laufen; Anmeldung, Patientendaten und Live-Synchronisierung werden von Supabase bereitgestellt.

## Funktionen

- Login mit freigegebenen Einsatzkonten
- Gemeinsame Patientendaten für alle angemeldeten Mitglieder
- Automatische Live-Aktualisierung
- Patientenstammdaten, Verletzungen, Medikation und Maßnahmen
- Triage mit zeitlichem Änderungsverlauf
- Versorgung, Transportstatus und Krankenhausdokumentation
- Farbliche Übersicht für transportbereite, unterwegs befindliche und angekommene Patienten
- Suche und Triagefilter
- Geschützter Datenzugriff durch Row Level Security

## 1. Datenbank einrichten

1. Das Supabase-Projekt öffnen.
2. Links **SQL Editor** auswählen.
3. **New query** öffnen.
4. Den vollständigen Inhalt aus `supabase.sql` einfügen.
5. **Run** ausführen.

Damit werden die Patiententabelle, die Mitgliederliste, Live-Updates und sämtliche Zugriffsregeln angelegt.

## 2. Erstes Benutzerkonto anlegen

1. In Supabase **Authentication → Users** öffnen.
2. **Add user** auswählen und E-Mail sowie Passwort festlegen.
3. Danach im SQL Editor ausführen und die Werte ersetzen:

```sql
insert into public.mci_members (user_id, display_name)
select id, 'Projektleitung' from auth.users where email = 'deine@email.de'
on conflict (user_id) do update set display_name = excluded.display_name;
```

Ein Auth-Benutzer erhält erst durch einen Eintrag in `mci_members` Zugriff auf Patientendaten.

## 3. Website mit Supabase verbinden

Im Supabase-Dashboard über **Connect** oder **Project Settings → API** die Projekt-URL und den **Publishable Key** kopieren. Danach `config.js` bearbeiten:

```js
window.MCI_CONFIG = {
  supabaseUrl: "https://DEIN-PROJEKT.supabase.co",
  supabasePublishableKey: "DEIN-PUBLISHABLE-KEY"
};
```

Der Publishable Key darf Bestandteil einer Browser-App sein. Niemals den `service_role`-Key in `config.js`, GitHub oder anderen öffentlichen Dateien speichern.

## 4. Auf GitHub Pages veröffentlichen

```powershell
git add .
git commit -m "Add secure Supabase login and shared database"
git push
```

Anschließend im GitHub-Repository unter **Settings → Pages** einstellen:

- Source: **Deploy from a branch**
- Branch: **main**
- Ordner: **/(root)**

Nach der Veröffentlichung zeigt die URL zunächst die Anmeldung. Nur gültige und in `mci_members` freigegebene Konten können das Board und seine Daten öffnen.

## Weitere Benutzer freigeben

Für jede Person zuerst unter **Authentication → Users** ein Konto erstellen. Danach die oben gezeigte SQL-Abfrage mit deren E-Mail und Anzeigenamen ausführen.

Zum Entziehen des Zugriffs:

```sql
delete from public.mci_members
where user_id = (select id from auth.users where email = 'person@email.de');
```

## Vorhandene lokale Daten

Wenn die gemeinsame Datenbank beim ersten Login noch leer ist und der Browser ältere lokale Datensätze enthält, bietet die App einmalig deren Übernahme an. Die lokale Kopie bleibt als Sicherheitskopie im Browser bestehen.
