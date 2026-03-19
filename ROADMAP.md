# SignalRadar Pro — Masterplan 2026

## Vision
Die beste Mobilfunk-Coverage-App Deutschlands. Zero Tracking, Made in Germany, 
unter 1MB, besser als Opensignal/nPerf/CellMapper kombiniert.

## Konkurrenz-Schwächen (Stand März 2026)
- **Opensignal** (10M+ DL, 4.0★): Location-Zwang, Popup-Spam ("Is your Internet working today?"), 57K 1-Star Reviews, Daten werden verkauft
- **nPerf** (10M+ DL, 4.6★): Ads + In-App Purchases, teilt Daten mit Dritten, riesige App
- **CellMapper** (1M+ DL, 2.7★): Zu technisch, buggy, Daten brauchen Tage zum Erscheinen, Ads
- **Network Cell Info** (3.8★): Hässliches UI, zu technisch für Normaluser
- **Coverage Map** (keine Bewertung sichtbar): Nur statische Karten, keine Interaktion

## Phase 1 — Killer Features

### 1. Integrierter Speed Test
- LibreSpeed (Open Source) einbauen
- Download/Upload/Ping direkt in der App
- Ergebnisse als Punkte auf der Karte speichern
- Location OPTIONAL (nicht erzwungen wie bei Opensignal)

### 2. Signal Score
- Echtzeit-Signalstärke vom Gerät (Network Information API)
- Kombination: berechnete (COST 231 Hata) + echte Signalwerte
- Ampel-System: "Hier hast du 92% Empfang"
- Einfach verständlich für jeden

### 3. Dead Zone Reporter
- User markiert Funklöcher auf der Karte
- Community-Crowdsourced (localStorage + optional Cloud)
- "Diese Straße = Funkloch bei O2"
- Einfacher als CellMapper

### 4. Provider Vergleich
- Side-by-side: "O2 vs Telekom an deinem Standort"
- Welcher Anbieter hat die meisten Masten in der Nähe?
- "Wechsel-Empfehlung" basierend auf lokaler Abdeckung
- USP: Das hat NIEMAND

### 5. Bundesnetzagentur Daten
- Offizielle Sendemasten-Daten der BNetzA einbinden
- Verifizierte Standorte zusätzlich zu Overpass/OSM
- Autoritative Quelle für Deutschland

## Phase 2 — Superior UX

### 6. Onboarding Flow
- "Wähle deinen Provider" → personalisierte Ansicht
- Sofort DEINE Masten highlighted
- 3 Sekunden bis zum Ergebnis

### 7. Offline Modus (erweitert)
- Tile-Caching erweitern
- Letzte Masten-Daten offline verfügbar
- "Zuletzt gesehen" Signaldaten

### 8. Dark/Light Theme
- Light Mode für draußen
- Auto-Switch nach Tageszeit
- 2026 SaaS Design: Glassmorphism, smooth Animationen

## Phase 3 — Play Store Launch

### 9. Marketing
- "Made in Germany 🇩🇪"
- "Zero Tracking — Deine Daten bleiben auf deinem Gerät"
- "52KB vs 100MB — Die leichteste Netzwerk-App der Welt"
- Privacy Policy, Screenshots, Feature Graphic, ASO

### 10. Monetarisierung
- Basis: KOMPLETT KOSTENLOS, KEINE WERBUNG
- Premium (2.99€): Speed Test History, Export, Provider-Vergleich Detail
- Alternative: Gumroad/Ko-fi Donation Model

## Tech Stack
- PWA (HTML/CSS/JS) → WebView APK
- Leaflet + MarkerCluster
- Overpass API (3 Endpoints Failover)
- COST 231 Hata Signalberechnung
- LibreSpeed (Speed Test)
- Service Worker (Offline/Caching)
- Bundesnetzagentur API/CSV

## Design Richtung
- 2026 SaaS Vibe: Clean, modern, top-notch
- Glassmorphism + subtle Animationen
- Responsive: Mobile-first, aber auch Desktop-tauglich
- Kein Feature-Bloat — jedes Feature muss sofort verständlich sein
