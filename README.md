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

### Bestehende Installation aktualisieren

Nach einem Update den aktuellen Inhalt von `supabase.sql` erneut vollständig im SQL Editor ausführen. Vorhandene Patienten ohne MCI-Zuordnung werden automatisch in einer abgeschlossenen **„Übernommene MCI“** archiviert. Anschließend die aktualisierten Dateien zu GitHub pushen.

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

## MCI-Workflow

Nach dem Login erscheint die MCI-Übersicht. Zuerst wird eine MCI mit Name, Scene Lead und Startzeit angelegt. Ort beziehungsweise Postal Code und Beschreibung sind optional. Patienten gehören ausschließlich zu diesem Einsatzblatt. Über **MCI abschließen** wird der Einsatz in die Historie verschoben. Abgeschlossene MCIs und ihre Patientendaten sind danach schreibgeschützt.

Das Änderungsprotokoll speichert ab Installation dieser Version automatisch, wer eine MCI oder einen Patienten angelegt, geändert, gelöscht oder abgeschlossen hat. Als Name wird der zum Änderungszeitpunkt in `mci_members` hinterlegte `display_name` gespeichert.

## Schwarzes Brett

Das Schwarze Brett ist über die Modulnavigation erreichbar. Ein Eintrag enthält Patientenname, Telefonnummer und Anliegen beziehungsweise Vorfall. Ersteller sowie Erstellzeitpunkt werden serverseitig aus der Anmeldung übernommen. Offene Einträge können bearbeitet werden; dabei speichert Supabase den letzten Bearbeiter und Änderungszeitpunkt. Beim Markieren als erledigt speichert Supabase auch die abschließende Person und den Zeitpunkt und verschiebt den Eintrag in die schreibgeschützte Historie.

## Labor Requests

Labor Requests enthalten Patientenname, Telefonnummer, eine optionale Probennummer und einen Hinweis. Ersteller und Zeitpunkte werden automatisch protokolliert. Offene Requests können bearbeitet und anschließend als erledigt in die schreibgeschützte Historie verschoben werden.

## Totenübersicht

Die Totenübersicht dokumentiert Patientenname, Todesdatum, vermuteten Todesumstand, Ansprechpartner beziehungsweise weitere Informationen und ein optionales Beisetzungsdatum. Obduktionsfreigabe und vorhandener Obduktionsbericht werden als Status angezeigt. Die Belegung aller 16 Kühlfächer ist direkt sichtbar; ein Fach kann technisch nicht doppelt vergeben und über den Bearbeitungsdialog wieder geleert werden. Beim Bestätigen eines Obduktionsberichts warnt die App vor dem endgültigen Abschluss, leert das zugehörige Kühlfach automatisch und verschiebt den schreibgeschützten Eintrag in die Historie. Ersteller, letzte Bearbeitung und Zeitpunkt werden automatisch über den angemeldeten Benutzer protokolliert.

## Weitere Benutzer freigeben

Für jede Person zuerst unter **Authentication → Users** ein Konto erstellen. Danach die oben gezeigte SQL-Abfrage mit deren E-Mail und Anzeigenamen ausführen.

### Recht zum Löschen von Historien

Standardmäßig darf kein Benutzer historische Einträge endgültig löschen. Das Sonderrecht gilt gemeinsam für abgeschlossene MCIs, erledigte Einträge am Schwarzen Brett, erledigte Labor Requests und abgeschlossene Einträge der Totenübersicht. Es wird im SQL Editor gezielt pro Benutzer vergeben:

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
