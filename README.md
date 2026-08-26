# MCI Board

Geschütztes, gemeinsames Einsatzboard für ein RP-Projekt. Die Website kann auf GitHub Pages laufen; Anmeldung, Patientendaten und Live-Synchronisierung werden von Supabase bereitgestellt.

## Funktionen

- Login mit freigegebenen Einsatzkonten
- Eigene Einsatzblätter für jede MCI
- Abschluss laufender MCIs und schreibgeschützte Historie
- Manipulationsgeschütztes Änderungsprotokoll mit Display Name, Zeitpunkt und geänderten Feldern
- Gemeinsames Schwarzes Brett mit offenen Einträgen und erledigter Historie
- Erweiterbare Modulnavigation für zusätzliche Seiten
- Labor Requests mit optionaler Probennummer und erledigter Historie
- Totenübersicht mit Obduktionsstatus und Live-Belegung von 16 Kühlfächern
- Optionales Sonderrecht zum endgültigen Löschen sämtlicher Historieneinträge
- Gemeinsame Patientendaten für alle angemeldeten Mitglieder
- Eigene Seite für normale Patientenübergaben ohne MCI, Triage und Patientennummer, mit schreibgeschützter Behandlungshistorie
- Automatische Live-Aktualisierung
- Patientenstammdaten, Verletzungen, Medikation und Maßnahmen
- Triage mit zeitlichem Änderungsverlauf
- Versorgung, Transportstatus und Krankenhausdokumentation
- Aufklappbarer OP-Bericht und Nachkontrolle mit Standarddatum heute + 2 Tage
- Farbliche Übersicht für transportbereite, unterwegs befindliche und angekommene Patienten
- Suche und Triagefilter
- Geschützter Datenzugriff durch Row Level Security
- Berechtigungsgeschützte Benutzerverwaltung für Konten und Sonderrechte
- Eigenes Passwort ändern und Passwörter durch die Benutzerverwaltung neu setzen
- Geschützte Psychologie-Akten mit behandelndem Personal und chronologischem Sitzungsverlauf
- Fire-Prevention-and-Investigation-Akten mit Personen, Brandursache, Beweismitteln und Ermittlungsverlauf

## 1. Datenbank einrichten

1. Das Supabase-Projekt öffnen.
2. Links **SQL Editor** auswählen.
3. **New query** öffnen.
4. Den vollständigen Inhalt aus `supabase.sql` einfügen.
5. **Run** ausführen.

Damit werden die MCI- und Übergabetabellen, die Mitgliederliste, Live-Updates und sämtliche Zugriffsregeln angelegt.

### Bestehende Installation aktualisieren

Nach einem Update den aktuellen Inhalt von `supabase.sql` erneut vollständig im SQL Editor ausführen. Vorhandene Patienten ohne MCI-Zuordnung werden automatisch in einer abgeschlossenen **„Übernommene MCI“** archiviert. Anschließend die aktualisierten Dateien zu GitHub pushen.

## 2. Erstes Benutzerkonto anlegen

1. In Supabase **Authentication → Users** öffnen.
2. **Add user** auswählen und E-Mail sowie Passwort festlegen.
3. Danach im SQL Editor ausführen und die Werte ersetzen:

```sql
insert into public.mci_members (user_id, display_name, can_manage_users)
select id, 'Projektleitung', true from auth.users where email = 'deine@email.de'
on conflict (user_id) do update
set display_name = excluded.display_name, can_manage_users = true;
```

Ein Auth-Benutzer erhält erst durch einen Eintrag in `mci_members` Zugriff auf Patientendaten. `can_manage_users` schaltet das Administrationsmodul frei.

## 3. Benutzerverwaltung bereitstellen

Die sensiblen Kontoaktionen laufen in der Edge Function `manage-users`; der `service_role`-Schlüssel gelangt dadurch nie in den Browser. Mit installierter [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) im Projektordner ausführen:

```powershell
supabase login
supabase link --project-ref DEINE-PROJEKT-ID
supabase functions deploy manage-users
```

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` werden einer bereitgestellten Supabase Edge Function automatisch zur Verfügung gestellt. Danach sehen ausschließlich Mitglieder mit `can_manage_users = true` den Menüpunkt **Benutzerverwaltung**.

## 4. Website mit Supabase verbinden

Im Supabase-Dashboard über **Connect** oder **Project Settings → API** die Projekt-URL und den **Publishable Key** kopieren. Danach `config.js` bearbeiten:

```js
window.MCI_CONFIG = {
  supabaseUrl: "https://DEIN-PROJEKT.supabase.co",
  supabasePublishableKey: "DEIN-PUBLISHABLE-KEY"
};
```

Der Publishable Key darf Bestandteil einer Browser-App sein. Niemals den `service_role`-Key in `config.js`, GitHub oder anderen öffentlichen Dateien speichern.

## 5. Auf GitHub Pages veröffentlichen

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

## MCI-Workflow

Nach dem Login erscheint die MCI-Übersicht. Zuerst wird eine MCI mit Name, Scene Lead und Startzeit angelegt. Ort beziehungsweise Postal Code und Beschreibung sind optional. Patienten gehören ausschließlich zu diesem Einsatzblatt. Über **MCI abschließen** wird der Einsatz in die Historie verschoben. Abgeschlossene MCIs und ihre Patientendaten sind danach schreibgeschützt.

Das Änderungsprotokoll speichert ab Installation dieser Version automatisch, wer eine MCI oder einen Patienten angelegt, geändert, gelöscht oder abgeschlossen hat. Als Name wird der zum Änderungszeitpunkt in `mci_members` hinterlegte `display_name` gespeichert.

## Schwarzes Brett

Das Schwarze Brett ist über die Modulnavigation erreichbar. Ein Eintrag enthält Patientenname, Telefonnummer, Fachbereich, die zuständige Angabe **Bearbeitet durch** und das Anliegen beziehungsweise den Vorfall. Ersteller sowie Erstellzeitpunkt werden serverseitig aus der Anmeldung übernommen. Offene Einträge können bearbeitet werden; dabei speichert Supabase den letzten Bearbeiter und Änderungszeitpunkt. Beim Markieren als erledigt speichert Supabase auch die abschließende Person und den Zeitpunkt und verschiebt den Eintrag in die schreibgeschützte Historie.

## Labor Requests

Labor Requests enthalten Patientenname, Telefonnummer, eine optionale Probennummer und einen Hinweis. Ersteller und Zeitpunkte werden automatisch protokolliert. Offene Requests können bearbeitet und anschließend als erledigt in die schreibgeschützte Historie verschoben werden.

## Totenübersicht

Die Totenübersicht dokumentiert Patientenname, Todesdatum, vermuteten Todesumstand, Ansprechpartner beziehungsweise weitere Informationen und ein optionales Beisetzungsdatum. Obduktionsfreigabe und vorhandener Obduktionsbericht werden als Status angezeigt. Die Belegung aller 16 Kühlfächer ist direkt sichtbar; ein Fach kann technisch nicht doppelt vergeben und über den Bearbeitungsdialog wieder geleert werden. Beim Bestätigen eines Obduktionsberichts warnt die App vor dem endgültigen Abschluss, leert das zugehörige Kühlfach automatisch und verschiebt den schreibgeschützten Eintrag in die Historie. Ersteller, letzte Bearbeitung und Zeitpunkt werden automatisch über den angemeldeten Benutzer protokolliert.

## Psychologie

Das Modul **Psychologie** ist nur für Benutzer mit der Berechtigung `can_access_psychology` sichtbar und zusätzlich durch Row Level Security geschützt. Eine Patientenakte enthält Aktennummer, Stammdaten, behandelndes Personal, Status und allgemeine Anmerkungen. Sitzungen werden chronologisch mit Anlass, Gesprächsverlauf, Einschätzung, Maßnahmen, Folgetermin und optionalem internem Vermerk dokumentiert. Abgeschlossene Akten und deren Sitzungen sind schreibgeschützt.

Die vorhandene Berechtigung **Historie endgültig löschen** gilt auch für abgeschlossene Psychologie-Akten. Beim Löschen werden die Akte und sämtliche enthaltenen Sitzungen unwiderruflich entfernt. Aktive oder pausierte Akten können nicht endgültig gelöscht werden.

## Fire Prevention and Investigation

Das geschützte Modul führt Brandermittlungsakten mit Aktennummer, Einsatzdaten, Objekt- und Brandstellenbeschreibung, leitendem Ermittler sowie klassifizierter Brandursache. Pro Akte können beliebig viele betroffene Personen und Proben beziehungsweise Beweismittel erfasst werden. Beweismittel besitzen Laborstatus, Probenergebnis, Labornummer und eine dokumentierbare Chain of Custody. Untersuchungsschritte, Befragungen, Laborergebnisse und Übergaben erscheinen chronologisch im unveränderlichen Aktenverlauf.

Der Zugriff benötigt `can_access_fire_investigation`. Abgeschlossene Akten und alle untergeordneten Daten sind schreibgeschützt. Die vorhandene Berechtigung **Historie endgültig löschen** entfernt eine abgeschlossene Brandermittlungsakte einschließlich Personen, Beweismitteln und Verlauf unwiderruflich.

## Weitere Benutzer freigeben

Weitere Konten werden nach dem Login direkt unter **Benutzerverwaltung** angelegt. Dort lassen sich Anzeigename, Passwort, Psychologie-Zugriff, Fire-Investigation-Zugriff, das Recht zum Löschen der Historie und das Recht zur Benutzerverwaltung bearbeiten. Jeder angemeldete Benutzer kann außerdem über **Passwort ändern** im Kopfbereich sein eigenes Passwort setzen. **Zugriff entziehen** entfernt nur die Board-Freigabe; das Auth-Konto bleibt in Supabase erhalten. Wird dieselbe E-Mail später erneut angelegt, reaktiviert die Verwaltung das Konto mit dem neuen Startpasswort. Die eigene Verwaltungsberechtigung sowie die letzte verbleibende Benutzerverwaltung können nicht entfernt werden.

### Recht zum Löschen von Historien

Standardmäßig darf kein Benutzer historische Einträge endgültig löschen. Das Sonderrecht gilt gemeinsam für abgeschlossene MCIs, Patientenübergaben, erledigte Einträge am Schwarzen Brett, erledigte Labor Requests und abgeschlossene Einträge der Totenübersicht. Es wird im SQL Editor gezielt pro Benutzer vergeben:

```sql
update public.mci_members
set can_delete_history = true
where user_id = (
  select id from auth.users where email = 'name@example.com'
);
```

Nach einer Änderung des Rechts muss sich der betreffende Benutzer einmal ab- und wieder anmelden. Zum Entziehen `can_delete_history` wieder auf `false` setzen. Das Löschen ist unwiderruflich; bei einer abgeschlossenen MCI werden auch alle zugehörigen Patienten- und Protokolldaten entfernt.

Zum Entziehen des Zugriffs:

```sql
delete from public.mci_members
where user_id = (select id from auth.users where email = 'person@email.de');
```

## Vorhandene lokale Daten

Wenn die gemeinsame Datenbank beim ersten Login noch leer ist und der Browser ältere lokale Datensätze enthält, bietet die App einmalig deren Übernahme an. Die lokale Kopie bleibt als Sicherheitskopie im Browser bestehen.
