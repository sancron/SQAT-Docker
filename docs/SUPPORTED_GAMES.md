# Unterstützte Spiele und Protokolle

## Prüfgrundlage

Die [4NetPlayers-Spieleübersicht](https://www.4netplayers.com/de/gameserver-mieten/) listet die angebotenen Titel, veröffentlicht aber keine vollständige Matrix der Query- und RCON-Protokolle. Die Zuordnung wurde deshalb gegen die [GameDig-Protokollliste](https://raw.githubusercontent.com/gamedig/node-gamedig/master/GAMES_LIST.md) und – bei Spezialprotokollen – gegen Hersteller- bzw. Community-Protokolldokumentationen gegengeprüft. GameDig ist dabei ein praxisnaher Implementierungs-/Kompatibilitätsquerschnitt, keine Garantie für jede 4NetPlayers-Instanz.

Das Tool entscheidet nicht anhand des Spielnamens, sondern anhand einer echten Protokollantwort. So werden auch nicht aufgeführte Spiele unterstützt, wenn sie eines der Adapterprotokolle korrekt anbieten.

## Im Tool direkt implementiert

| Adapter | Transport | Verfügbarkeit | Spiele / Fälle |
| --- | --- | --- | --- |
| A2S / Steam Query | UDP | eingebaut | Viele Steam-/Valve-Spiele sowie Arma 3, Arma Reforger, DayZ, Project Zomboid, Path of Titans, Rust, 7 Days to Die, ARK, Conan Exiles, Garry's Mod, Hell Let Loose, Insurgency Sandstorm, Killing Floor 2, Mordhau, Myth of Empires, Squad, The Forest, The Front, The Isle (Legacy), Unturned, Valheim, VEIN, V Rising, Space Engineers und weitere. |
| Minecraft Java Status | TCP | eingebaut | Minecraft Java Edition |
| Minecraft Bedrock / RakNet | UDP | eingebaut | Minecraft Bedrock Edition |
| Satisfactory Lightweight Query | UDP | eingebaut | Satisfactory; liefert primär Status-/Versionsdaten, keine standardisierten Spielerlisten. |
| FiveM HTTP Query | HTTP | eingebaut | FiveM mit erreichbaren `info.json`, `players.json` und/oder `dynamic.json`-Endpunkten. |
| Palworld REST API | HTTP | eingebaut | Palworld Dedicated Server mit aktivierter REST API; der Info-Endpunkt ist `/v1/api/info`. |

### A2S-Hinweise

Der A2S-Adapter fragt zuerst die Basisinformationen ab. `A2S_PLAYER` und `A2S_RULES` werden separat versucht. Wenn ein Server diese Zusatzabfragen nicht anbietet, zeigt das Tool trotzdem die Basisinformationen und kennzeichnet die fehlenden Daten. Das ist unter anderem bei Conan Exiles, Arma Reforger und einzelnen DayZ-/Zomboid-Versionen zu erwarten.

Bei Path of Titans muss die Source-Query-Funktion serverseitig aktiviert sein; laut der dokumentierten Serverkonfiguration liegt der Query-Port häufig beim Spielport plus 4. Maßgeblich ist der Port aus dem Hosting-Panel.

### Spezialadapter

- Satisfactory nutzt ein eigenes Lightweight-Query-UDP-Format. Das Tool wertet Magic, Antworttyp, Version, Cookie, Serverzustand, NetCL, Flags und Teilzustände aus.
- FiveM liefert Statusdaten typischerweise über HTTP-JSON-Endpunkte. Diese Endpunkte können deaktiviert oder geschützt sein.
- Palworld nutzt für Serverinformationen die offizielle REST API. Die REST API muss aktiviert und ihr Port erreichbar sein. Zugangsdaten werden in diesem reinen Info-Adapter nicht automatisch erraten oder gespeichert.

## RCON-Adapter

| Adapter | Transport | Eingebaut für | Wichtige Hinweise |
| --- | --- | --- | --- |
| Source RCON | TCP | Path of Titans, Minecraft Java, Project Zomboid, Factorio, Eco sowie weitere kompatible Server | Das Paketformat ist nicht automatisch gleichbedeutend mit aktivierter RCON-Funktion. Für Palworld nur verwenden, wenn die konkrete Distribution Source-RCON-kompatibel ist. |
| BattlEye / Bohemia RCon | UDP | Arma 3, DayZ, Arma Reforger | Passwort und RCon-Port müssen in der BattlEye-/Serverkonfiguration aktiviert sein. Arma Reforger verwendet eine UDP-RCON-Schnittstelle; der Default-Port ist laut Serverdokumentation 19999. |
| Rust WebRCON | WebSocket | Rust | Rust muss WebRCON aktivieren und den WebSocket-Port erreichbar machen. |

RCON-Befehle sind spielspezifisch. Das Tool übermittelt den eingegebenen Befehl und zeigt die Antwort an; es inventarisiert nicht automatisch alle möglichen Admin-Kommandos des Spiels.

## 4NetPlayers-Kandidaten ohne eigenen Spezialparser

Diese Titel werden bei einer passenden Protokollantwort über den generischen A2S-Adapter unterstützt, soweit die konkrete Serverversion A2S anbietet: ARK, Arma 3, Arma Reforger, Conan Exiles, DayZ, Garry's Mod, Hell Let Loose, Insurgency Sandstorm, Killing Floor 2, Mordhau, Myth of Empires, Path of Titans, Project Zomboid, Rust, 7 Days to Die, Satisfactory, Squad, The Forest, The Front, The Isle, Unturned, Valheim, VEIN, V Rising und weitere Valve-/Steam-Query-Titel.

Für Spiele mit EOS, proprietärer HTTP-API oder modabhängigem Query gibt es keine pauschale A2S-Garantie. Dazu gehören insbesondere Varianten von Enshrouded, The Isle Evrima, Farming Simulator, Terraria/TShock, SCUM, BattleBit, Ground Branch und Vintage Story. Diese Fälle bleiben in der Dokumentation bewusst als „separat zu prüfen“ markiert, statt ein nicht verifiziertes Paketformat zu simulieren.

## Konfigurations- und Port-Hinweise

- Query-Port und RCON-Port sind getrennte Werte. Immer die Portangabe des jeweiligen 4NetPlayers-Servers verwenden.
- Minecraft Java: Server List Ping über TCP; RCON ist separat über `enable-rcon=true`, `rcon.password` und `rcon.port` zu aktivieren.
- Arma 3 / DayZ: BattlEye-RCon wird typischerweise über `RConPassword`, `RConPort` und `RestrictRCon` konfiguriert.
- Arma Reforger: A2S und RCON sind optionale, eigene UDP-Schnittstellen in der JSON-Serverkonfiguration; die Standardwerte liegen laut Bohemia-Dokumentation bei A2S 17777 und RCON 19999.
- Palworld: REST API und RCON sind getrennte Serveroptionen. Eine erreichbare Game-Portnummer bedeutet nicht automatisch, dass REST oder RCON aktiv sind.
- Rust: WebRCON benötigt einen aktivierten RCON-Port, ein Passwort und die WebSocket-Option.

## Wenn ein Spiel nicht antwortet

1. Den Query- bzw. RCON-Port aus dem Hosting-Panel verwenden, nicht automatisch den Spielport.
2. Prüfen, ob der Port im Firewall-/NAT-Setup aus dem Container-Netzwerk erreichbar ist.
3. Das bekannte Protokoll explizit auswählen, um Fehlermeldungen eindeutig zu halten.
4. Query und RCON getrennt testen: Ein Server kann Query unterstützen, aber RCON deaktiviert haben – oder umgekehrt.
5. Bei EOS, proprietären APIs, Mods oder Host-spezifischen Erweiterungen ist ein eigener Adapter nötig. Erst wenn das Paketformat verifiziert ist, sollte es in `src/adapters.ts` ergänzt werden.

## Quellen

- [4NetPlayers Gameserver-Angebot](https://www.4netplayers.com/de/gameserver-mieten/)
- [GameDig Games-/Protokollliste](https://raw.githubusercontent.com/gamedig/node-gamedig/master/GAMES_LIST.md)
- [Arma Reforger Server Config – Bohemia Interactive Community](https://community.bistudio.com/wiki/Arma_Reforger%3AServer_Config)
- [Arma Reforger Update-Hinweis zur RCON-Protokollkompatibilität](https://reforger.armaplatform.com/news/update-march-13-2024)
- [BattlEye RCon Protocol](https://de.wikipedia.org/wiki/BattleEye_RCon_Protocol)
- [Satisfactory Lightweight Query](https://docs.ficsit.app/satisfactory-modding/latest/Development/Satisfactory/QueryProtocol.html)
- [Minecraft Server List Ping](https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping)
- [Palworld REST API](https://docs.palworldgame.com/category/rest-api)
- [Rust Dedicated Server / WebRCON](https://wiki.facepunch.com/rust/Creating_a_server)
- [Factorio Server Command Line / RCON](https://wiki.factorio.com/Command_line_parameters)
- [Eco RCON](https://wiki.play.eco/en/Server_Commands)