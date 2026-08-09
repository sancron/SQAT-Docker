# Support Query Tool

Universelles, passwortgeschütztes Deno-Webtool zur technischen Prüfung von Gameservern und zum Senden von RCON-Befehlen. Das Projekt liegt unabhängig vom ursprünglichen `Path_of_Titans_Query` im Ordner `Support_Query_Tool` und nutzt dieselbe Betriebsbasis: Docker, Docker Compose/Portainer und Deno.

## Eingebaute Adapter

- A2S / Steam Query über UDP mit `A2S_INFO`, optional `A2S_PLAYER` und `A2S_RULES` inklusive Challenge-Handshake
- Minecraft Java Server List Ping über TCP
- Minecraft Bedrock Server Ping über UDP/RakNet
- Satisfactory Lightweight Query über UDP
- FiveM öffentliche HTTP-Status-Endpunkte (`info.json`, `players.json`, `dynamic.json`)
- Palworld REST API Info-Endpunkt
- SCUM-Masterserver-Query über TCP/405 mit `LST\0\0` plus optionale direkte A2S-Prüfung
- Source-RCON-kompatibles TCP-RCON für kompatible Spiele
- BattlEye/Bohemia RCon über UDP für Arma 3, DayZ und Arma Reforger
- Rust WebRCON über WebSocket
- Automatikmodus mit sichtbarer Liste aller geprüften Protokolle
- Anzeige aller vom jeweiligen Server gelieferten Felder, Spieler, Regeln, Warnungen und Rohantworten

Die Adapter sind in [`src/adapters.ts`](src/adapters.ts) von der HTTP-, Authentifizierungs- und UI-Schicht getrennt. Weitere Protokolle können dadurch ergänzt werden, ohne die bestehende Oberfläche neu zu bauen.

## Lokal starten

```powershell
Copy-Item .env.example .env
# SUPPORT_PASSWORD in .env setzen
docker compose up -d --build
```

Danach ist das Tool unter `http://SERVER-IP:8080` erreichbar. Der externe Port kann über `PORT` geändert werden.

Für einen direkten Deno-Test:

```powershell
$env:SUPPORT_PASSWORD = "lokales-test-passwort"
deno task check
deno task start
```

Für SCUM muss `SCUM_MASTER_SERVERS=13.244.99.178:405` gesetzt sein. Eine bereits vorhandene `.env` mit den früheren TCP/1040-Einträgen überschreibt den aktuellen Compose-Default und führt zum SCUMetrics-Fallback.

## Portainer

1. `SUPPORT_PASSWORD` und optional `PORT` in einer `.env` bzw. in den Stack-Umgebungsvariablen setzen.
2. In Portainer **Stacks → Add stack** öffnen.
3. Den Projektordner bzw. das Repository mit `docker-compose.yml` verwenden.
4. Den Stack deployen.

Das bestehende externe Docker-Netzwerk `npm-network` wird wie beim Path-of-Titans-Tool erwartet. Falls es auf dem Host noch nicht existiert, einmalig anlegen oder den Netzwerkabschnitt auf das vorhandene Reverse-Proxy-Netzwerk anpassen.

Die Compose-Datei enthält einen Healthcheck auf `/api/health` und das Label `com.centurylinklabs.watchtower.enable=false`. Watchtower aktualisiert diesen Container dadurch vorerst nicht automatisch.

## Sicherheit

Das Support-Passwort wird nur serverseitig geprüft. Die Sitzung nutzt ein HttpOnly-/SameSite-Cookie. RCON-Passwörter werden nicht geloggt und nicht persistiert. Für den Betrieb im Internet sollte zusätzlich ein Reverse Proxy mit HTTPS eingesetzt werden; dann `COOKIE_SECURE=true` setzen. Der Footer-Rechtshinweis kann über `FOOTER_NOTICE` als Stack-/ENV-Variable angepasst werden. Das Tool sollte nur für eigene bzw. ausdrücklich zur Prüfung freigegebene Server verwendet werden.

## Unterstützte Spiele und Protokolle

Die vollständige Matrix mit Status, Ports, Voraussetzungen und Quellen steht in [`docs/SUPPORTED_GAMES.md`](docs/SUPPORTED_GAMES.md). Entscheidend ist immer die tatsächliche Serverantwort: Ein Spiel kann je nach Version, Mod, Serveranbieter, Firewall oder deaktivierter Option keine Query- oder RCON-Antwort liefern.

Der geschützte Endpoint `GET /api/adapters` liefert die im Build registrierten Adapter maschinenlesbar zurück.

## 4NetPlayers CI

Die Oberfläche bleibt bewusst im Darkmodus und verwendet die aus dem 4Players-Styleguide abgeleiteten Kernfarben Maire (#181817), 4P Red (#EB1B2E), Real White und Light Grey. Das horizontale 4NetPlayers-Logo wird als Webseitenlogo verwendet; das 4NetPlayers-Globe dient als Favicon.

Die verwendeten, lokal ausgelieferten Assets liegen in [public/4netplayers-horizontal-white.svg](public/4netplayers-horizontal-white.svg) und [public/4np-globe-white.svg](public/4np-globe-white.svg). Das Docker-Image kopiert den public-Ordner automatisch mit und liefert die Assets über /assets/... aus.
