# SocialGuard – Deploy-Anleitung

## In 5 Minuten online auf Render.com (kostenlos)

### Schritt 1 – GitHub
1. Gehe auf github.com → "New repository" → Name: "socialguard" → "Create"
2. Lade alle Dateien hoch (server.js, package.json, den Ordner public/)

### Schritt 2 – Render.com
1. Gehe auf render.com → "New +" → "Web Service"
2. Verbinde dein GitHub-Konto → wähle das Repository "socialguard"
3. Einstellungen:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
4. Klick "Create Web Service" → in 2 Min. läuft die App

### Schritt 3 – Im Unterricht
1. Die App bekommt eine URL wie: `https://socialguard-xyz.onrender.com`
2. QR-Code daraus erstellen auf: qrcode-monkey.com
3. QR-Code an die Tafel projizieren → Schüler scannen mit iPad → fertig

## Spielablauf (45 Min.)

| Phase | Dauer | Was passiert |
|-------|-------|-------------|
| Alle treten bei | 3 Min. | QR-Code scannen, Gruppe wählen, Namen eingeben |
| Phase 1 – Analyse | 20 Min. | Jede Gruppe analysiert ihr Profil, gibt Bescheid ab |
| Phase 2 – Erstellen | 10 Min. | Jede Gruppe erfindet einen eigenen Finfluencer-Account |
| Phase 3 – Ratespiel | 10 Min. | Alle bewerten die fremden Profile → Punkte |
| Auswertung | 2 Min. | Scoreboard + Auflösung live auf Beamer |

## Lehrkraft-Steuerung
- 🎓-Symbol unten rechts öffnet das Teacher-Panel
- Von dort alle Phasen starten und stoppen
- Reset setzt alles zurück für die nächste Klasse
