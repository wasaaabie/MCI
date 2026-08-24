# MCI Board

Eine einfache, responsive Web-App zur Patientendokumentation bei einem Major Casualty Incident (MCI).

## Funktionen

- Patientenstammdaten, Personenbeschreibung und Verletzungsmuster
- Triage nach Rot, Gelb und Grün sowie „verstorben“
- Dokumentation von Medikation, Maßnahmen, Einheiten, Behandlungsplatz und Transportziel
- Status vor Ort und im Krankenhaus
- Suche, Filter und Einsatzübersicht
- Lokale Speicherung im Browser

## Lokal starten

Die `index.html` kann direkt im Browser geöffnet werden. Alternativ mit einem lokalen Webserver:

```bash
python -m http.server 8080
```

Danach `http://localhost:8080` öffnen.

## Auf GitHub Pages veröffentlichen

1. Dateien in ein GitHub-Repository hochladen.
2. Unter **Settings → Pages** bei **Build and deployment** die Option **Deploy from a branch** wählen.
3. Branch `main` und Ordner `/ (root)` auswählen und speichern.

## Wichtiger Hinweis

Die Daten liegen ausschließlich im `localStorage` des jeweiligen Browsers. Mehrere Geräte teilen ihre Daten nicht automatisch. Für reale personenbezogene Gesundheitsdaten sind Datenschutz, Zugriffsschutz, Verschlüsselung, Backups und die Vorgaben der verantwortlichen Organisation zu beachten. GitHub Pages stellt dafür kein geschütztes Backend bereit.
