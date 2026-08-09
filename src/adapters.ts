// Protocol adapters are kept separate from the HTTP/authentication layer so
// adding another game protocol does not require changing the web application.

import { createSocket } from "node:dgram";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const QUERY_TIMEOUT_MS = 2_000;
const RCON_TIMEOUT_MS = 3_000;

export type QueryProtocol =
  | "auto"
  | "a2s"
  | "minecraft-java"
  | "minecraft-bedrock"
  | "satisfactory"
  | "fivem"
  | "palworld-rest"
  | "scum";
export type RconProtocol =
  | "source-rcon"
  | "battlEye-rcon"
  | "rust-websocket";
export type FieldValue = string | number | boolean | null | undefined;
export type QueryResult = {
  online: boolean;
  transport: string;
  target: string;
  latencyMs?: number;
  serverPingMs?: number;
  message: string;
  fields: Record<string, FieldValue>;
  players?: Array<Record<string, FieldValue>>;
  rules?: Array<{ key: string; value: string }>;
  attempts?: Array<{ transport: string; message: string }>;
  warnings?: string[];
};
export type RconResult = {
  target: string;
  response: string;
  latencyMs: number;
  protocol: string;
};

export class AdapterError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "adapter_unavailable", status = 502) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.status = status;
  }
}

export type AdapterDependencies = {
  isValidHost: (host: string) => boolean;
  targetHost: (host: string) => string;
  displayTarget: (host: string, port: number) => string;
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Zeitüberschreitung.")),
      milliseconds,
    );
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function readExactSync(
  data: Uint8Array,
  offset: number,
  length: number,
): Uint8Array {
  if (offset < 0 || offset + length > data.length) {
    throw new Error("Unvollständige Serverantwort.");
  }
  return data.subarray(offset, offset + length);
}
function readUInt16LE(data: Uint8Array, offset: number): number {
  return new DataView(
    readExactSync(data, offset, 2).buffer,
    readExactSync(data, offset, 2).byteOffset,
    2,
  ).getUint16(0, true);
}
function readUInt32LE(data: Uint8Array, offset: number): number {
  return new DataView(
    readExactSync(data, offset, 4).buffer,
    readExactSync(data, offset, 4).byteOffset,
    4,
  ).getUint32(0, true);
}
function readFloat32LE(data: Uint8Array, offset: number): number {
  return new DataView(
    readExactSync(data, offset, 4).buffer,
    readExactSync(data, offset, 4).byteOffset,
    4,
  ).getFloat32(0, true);
}
function readBigUInt64LE(data: Uint8Array, offset: number): bigint {
  const bytes = readExactSync(data, offset, 8);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getBigUint64(0, true);
}

function sendUdp(
  packet: Uint8Array,
  host: string,
  port: number,
): Promise<Uint8Array> {
  const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
  return timeout(
    new Promise<Uint8Array>((resolve, reject) => {
      const cleanup = () => {
        socket.off("error", onError);
        socket.off("message", onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onMessage = (message: Uint8Array) => {
        cleanup();
        resolve(message);
      };
      socket.once("error", onError);
      socket.once("message", onMessage);
      socket.send(packet, port, host.replace(/^\\[|\\]$/g, ""), (error) => {
        if (error) onError(error);
      });
    }),
    QUERY_TIMEOUT_MS,
  ).finally(() => {
    try {
      socket.close();
    } catch { /* already closed */ }
  });
}

function uint64Bytes(value: bigint): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, true);
  return result;
}

function displayTarget(host: string, port: number): string {
  return host.includes(":") && !host.startsWith("[")
    ? `[${host}]:${port}`
    : `${host}:${port}`;
}

async function querySatisfactory(
  host: string,
  port: number,
): Promise<QueryResult> {
  const started = performance.now();
  const cookie = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  // Satisfactory's Lightweight Query protocol: magic 0xF6D5 LE, poll (0), v1.
  const packet = concatBytes(
    Uint8Array.from([0xd5, 0xf6, 0x00, 0x01]),
    uint64Bytes(cookie),
  );
  try {
    const response = await sendUdp(packet, host, port);
    if (
      response.length < 13 || readUInt16LE(response, 0) !== 0xf6d5 ||
      response[2] !== 0x01
    ) {
      throw new Error("Keine gültige Satisfactory-Lightweight-Query-Antwort.");
    }
    const responseCookie = readBigUInt64LE(response, 4);
    if (responseCookie !== cookie) {
      throw new Error("Query-Cookie stimmt nicht überein.");
    }
    const state = response[12];
    const stateName =
      ({ 1: "Idle", 2: "Loading", 3: "Playing" } as Record<number, string>)[
        state
      ] ?? `Unbekannt (${state})`;
    return {
      online: true,
      transport: "Satisfactory Lightweight Query (UDP)",
      target: displayTarget(host, port),
      latencyMs: Math.round(performance.now() - started),
      message: "Der Satisfactory-Server antwortet auf die Lightweight Query.",
      fields: {
        "Serverstatus": stateName,
        "ServerNetCL": readUInt32LE(response, 13),
        "Flags": readBigUInt64LE(response, 17).toString(),
        "Teilzustände": response[25],
      },
      warnings: [
        "Die Lightweight Query liefert primär den Serverzustand; Spieler- und Weltdaten sind darüber nicht standardisiert verfügbar.",
      ],
    };
  } catch (error) {
    throw new AdapterError(
      `Keine Satisfactory-Antwort: ${
        error instanceof Error ? error.message : "Netzwerkfehler"
      }`,
      "satisfactory_unavailable",
    );
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await timeout(fetch(url, init), QUERY_TIMEOUT_MS);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ungültige JSON-Antwort.");
  }
  return value as Record<string, unknown>;
}

async function queryFiveM(host: string, port: number): Promise<QueryResult> {
  const started = performance.now();
  const base = `http://${host}:${port}`;
  try {
    const [info, players, dynamic] = await Promise.allSettled([
      fetchJson(`${base}/info.json`),
      fetchJson(`${base}/players.json`),
      fetchJson(`${base}/dynamic.json`),
    ]);
    if (
      info.status === "rejected" && players.status === "rejected" &&
      dynamic.status === "rejected"
    ) {
      throw new Error("Keine FiveM-HTTP-Endpunkte erreichbar.");
    }
    const infoValue = info.status === "fulfilled" && !Array.isArray(info.value)
      ? info.value as Record<string, unknown>
      : {};
    const dynamicValue =
      dynamic.status === "fulfilled" && !Array.isArray(dynamic.value)
        ? dynamic.value as Record<string, unknown>
        : {};
    const playerValue = players.status === "fulfilled" ? players.value : {};
    const playerList = Array.isArray(playerValue) ? playerValue : undefined;
    return {
      online: true,
      transport: "FiveM HTTP Query",
      target: displayTarget(host, port),
      latencyMs: Math.round(performance.now() - started),
      message:
        "Der FiveM-Server antwortet über die öffentlichen HTTP-Status-Endpunkte.",
      fields: {
        "Hostname": typeof infoValue.hostname === "string"
          ? infoValue.hostname
          : undefined,
        "Version": typeof infoValue.version === "string"
          ? infoValue.version
          : undefined,
        "Spieler": typeof dynamicValue.clients === "number"
          ? dynamicValue.clients
          : undefined,
        "Maximale Spieler": typeof dynamicValue.sv_maxclients === "number"
          ? dynamicValue.sv_maxclients
          : undefined,
        "Ressourcen": Array.isArray(infoValue.resources)
          ? infoValue.resources.length
          : undefined,
      },
      players: playerList?.map((player) =>
        typeof player === "object" && player !== null
          ? player as Record<string, FieldValue>
          : { "Wert": String(player) }
      ),
      warnings: [
        "FiveM-HTTP-Status-Endpunkte sollten nur über vertrauenswürdige Netzwerke erreichbar sein; der Server kann die Endpunkte deaktivieren oder schützen.",
      ],
    };
  } catch (error) {
    throw new AdapterError(
      `Keine FiveM-Antwort: ${
        error instanceof Error ? error.message : "Netzwerkfehler"
      }`,
      "fivem_unavailable",
    );
  }
}

async function queryPalworldRest(
  host: string,
  port: number,
): Promise<QueryResult> {
  const started = performance.now();
  try {
    const info = await fetchJson(
      `http://${host}:${port}/v1/api/info`,
    ) as Record<string, unknown>;
    return {
      online: true,
      transport: "Palworld REST API",
      target: displayTarget(host, port),
      latencyMs: Math.round(performance.now() - started),
      message:
        "Die Palworld REST API antwortet. Für geschützte APIs werden Zugangsdaten benötigt; dieser Statusadapter fragt bewusst nur den öffentlichen Info-Endpunkt ab.",
      fields: Object.fromEntries(
        Object.entries(info).filter(([key]) =>
          !/password|token|secret/i.test(key)
        ).map((
          [key, value],
        ) => [
          key,
          typeof value === "string" || typeof value === "number" ||
            typeof value === "boolean" || value === null
            ? value
            : JSON.stringify(value),
        ]),
      ) as Record<string, FieldValue>,
      warnings: [
        "Die Palworld REST API muss serverseitig aktiviert und erreichbar sein. RCON ist bei Palworld distributionsabhängig; nutze dafür den Source-RCON-Adapter, sofern der Anbieter ihn bereitstellt.",
      ],
    };
  } catch (error) {
    throw new AdapterError(
      `Keine Palworld-REST-Antwort: ${
        error instanceof Error ? error.message : "Netzwerkfehler"
      }`,
      "palworld_rest_unavailable",
    );
  }
}

const SCUM_QUERY_TIMEOUT_MS = 2_000;
const SCUM_A2S_INFO_REQUEST = Uint8Array.from([
  0xff,
  0xff,
  0xff,
  0xff,
  0x54,
  ...encoder.encode("Source Engine Query"),
  0x00,
]);

function isA2sChallenge(data: Uint8Array): boolean {
  return data.length >= 9 && data[0] === 0xff && data[1] === 0xff &&
    data[2] === 0xff && data[3] === 0xff && data[4] === 0x41;
}

function sendUdpOnSocket(
  socket: ReturnType<typeof createSocket>,
  packet: Uint8Array,
  host: string,
  port: number,
): Promise<Uint8Array> {
  return timeout(
    new Promise<Uint8Array>((resolve, reject) => {
      const cleanup = () => {
        socket.off("error", onError);
        socket.off("message", onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onMessage = (message: Uint8Array) => {
        cleanup();
        resolve(message);
      };
      socket.once("error", onError);
      socket.once("message", onMessage);
      socket.send(packet, port, host.replace(/^\[|\]$/g, ""), (error) => {
        if (error) onError(error);
      });
    }),
    SCUM_QUERY_TIMEOUT_MS,
  );
}

async function queryScumA2s(
  host: string,
  port: number,
): Promise<QueryResult> {
  const started = performance.now();
  const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
  try {
    let response = await sendUdpOnSocket(
      socket,
      SCUM_A2S_INFO_REQUEST,
      host,
      port,
    );
    for (let attempt = 0; attempt < 2 && isA2sChallenge(response); attempt++) {
      response = await sendUdpOnSocket(
        socket,
        concatBytes(SCUM_A2S_INFO_REQUEST, response.subarray(5, 9)),
        host,
        port,
      );
    }
    if (isA2sChallenge(response)) {
      throw new Error("Der A2S-Challenge-Handshake wurde nicht akzeptiert.");
    }
    const fields = parseScumA2sInfo(response);
    return {
      online: true,
      transport: "SCUM Query (optionale A2S-Prüfung über UDP)",
      target: displayTarget(host, port),
      latencyMs: Math.round(performance.now() - started),
      message: "Der SCUM-Server antwortet.",
      fields,
    };
  } finally {
    try {
      socket.close();
    } catch { /* already closed */ }
  }
}

function parseScumA2sInfo(data: Uint8Array): Record<string, FieldValue> {
  if (
    data.length < 6 || data[0] !== 0xff || data[1] !== 0xff ||
    data[2] !== 0xff || data[3] !== 0xff || data[4] !== 0x49
  ) {
    throw new Error("Keine gültige A2S_INFO-Antwort.");
  }
  let offset = 6;
  const readString = (): string => {
    const end = data.indexOf(0, offset);
    if (end < 0) throw new Error("Unvollständige A2S_INFO-Antwort.");
    const value = decoder.decode(data.subarray(offset, end));
    offset = end + 1;
    return value;
  };
  const protocol = data[offset++];
  const name = readString();
  const map = readString();
  const folder = readString();
  const game = readString();
  const appId = readUInt16LE(data, offset);
  offset += 2;
  const players = data[offset++];
  const maxPlayers = data[offset++];
  const bots = data[offset++];
  const serverType = data[offset++];
  const environment = data[offset++];
  const visibility = data[offset++] === 0 ? "Öffentlich" : "Passwortgeschützt";
  const vac = data[offset++] === 1;
  const version = readString();
  return {
    "Protokollversion": protocol,
    "Servername": name,
    "Karte": map,
    "Ordner": folder,
    "Spiel": game,
    "App-ID": appId,
    "Spieler": players,
    "Maximale Spieler": maxPlayers,
    "Bots": bots,
    "Servertyp": serverType === 0x64 ? "Dedicated" : "Unbekannt",
    "Betriebssystem": environment === 0x6c
      ? "Linux"
      : environment === 0x77
      ? "Windows"
      : "Unbekannt",
    "Zugriff": visibility,
    "VAC": vac ? "Aktiv" : "Nicht aktiv",
    "Serverversion": version,
  };
}

const DEFAULT_SCUM_MASTER_SERVERS: ReadonlyArray<[string, number]> = [
  ["13.244.99.178", 405],
];

function scumMasterServers(): ReadonlyArray<[string, number]> {
  const configured = Deno.env.get("SCUM_MASTER_SERVERS")?.trim();
  if (!configured) return DEFAULT_SCUM_MASTER_SERVERS;
  const servers = configured.split(",").map((entry) => {
    const [host, portText] = entry.trim().split(":");
    const port = Number.parseInt(portText ?? "405", 10);
    return host && Number.isInteger(port) && port >= 1 && port <= 65535
      ? [host, port] as [string, number]
      : undefined;
  }).filter((server): server is [string, number] => server !== undefined);
  return servers.length > 0 ? servers : DEFAULT_SCUM_MASTER_SERVERS;
}
const SCUM_MASTER_TIMEOUT_MS = 5_000;
const SCUM_MASTER_RESPONSE_HEADER_SIZE = 4;
const SCUM_MASTER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SCUM_MASTER_RECORD_HEADER_SIZE = 30;
const SCUM_MASTER_RECORD_PREFIX_SIZE = 23;
const SCUM_MASTER_RECORD_TRAILER = Uint8Array.from([0xef, 0xbe]);

type ScumMasterRecord = {
  ip: string;
  port: number;
  name: string;
  players: number;
  maxPlayers: number;
  serverPingMs: number;
  tps: number;
};

async function writeScumTcp(
  conn: Deno.Conn,
  data: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    offset += await timeout(
      conn.write(data.subarray(offset)),
      SCUM_MASTER_TIMEOUT_MS,
    );
  }
}

async function readScumTcp(
  conn: Deno.Conn,
  length: number,
): Promise<Uint8Array> {
  const data = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const read = await timeout(
      conn.read(data.subarray(offset)),
      SCUM_MASTER_TIMEOUT_MS,
    );
    if (read === null) {
      throw new Error("SCUM-Masterserver hat die Verbindung beendet.");
    }
    offset += read;
  }
  return data;
}

function parseScumMasterRecords(data: Uint8Array): ScumMasterRecord[] {
  const records: ScumMasterRecord[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (data.length - offset < SCUM_MASTER_RECORD_HEADER_SIZE) {
      throw new Error("Unvollständiger SCUM-Masterserver-Datensatz.");
    }
    const nameLength = data[offset + SCUM_MASTER_RECORD_PREFIX_SIZE + 6];
    const nameStart = offset + SCUM_MASTER_RECORD_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + SCUM_MASTER_RECORD_TRAILER.length > data.length) {
      throw new Error("Unvollständige SCUM-Serverbezeichnung.");
    }

    // The current client response uses a six-byte, version-dependent status
    // marker before the name. Its framing is the length byte plus EF BE;
    // older captures contain an optional NUL immediately before EF BE.
    const trailerStart = data[nameEnd] === 0 ? nameEnd + 1 : nameEnd;
    if (
      trailerStart + SCUM_MASTER_RECORD_TRAILER.length > data.length ||
      data[trailerStart] !== SCUM_MASTER_RECORD_TRAILER[0] ||
      data[trailerStart + 1] !== SCUM_MASTER_RECORD_TRAILER[1]
    ) {
      throw new Error("Ungültiger SCUM-Masterserver-Datensatzabschluss.");
    }

    records.push({
      // SCUM stores IPv4 octets in reverse order and the port as uint16 LE.
      ip: [data[offset + 3], data[offset + 2], data[offset + 1], data[offset]]
        .join("."),
      port: data[offset + 4] | data[offset + 5] << 8,
      // The current variable record keeps player count and capacity directly
      // after the 0xDEAD marker.
      players: data[offset + 9],
      maxPlayers: data[offset + 10],
      // These little-endian floats match the in-game server-list ping and
      // the server-reported tick rate (e.g. 16.53 ms and 4.999 TPS).
      serverPingMs: readFloat32LE(data, offset + 13),
      tps: readFloat32LE(data, offset + 17),
      name: decoder.decode(data.subarray(nameStart, nameEnd)).trim(),
    });
    offset = trailerStart + SCUM_MASTER_RECORD_TRAILER.length;
  }
  return records;
}

// SCUMs eigener Masterserver-Client verwendet dieses binäre Serverlisten-Kommando.
// Es ist kein A2S-Paket und benötigt weder Steam-Login noch einen Spielnamen.
const SCUM_MASTER_QUERY = Uint8Array.from([0x4c, 0x53, 0x54, 0x00, 0x00]);
const SCUM_MASTER_MAX_RECORDS = 20_000;

async function queryScumMaster(
  host: string,
  port: number,
): Promise<ScumMasterRecord[]> {
  const conn = await timeout(
    Deno.connect({ hostname: host, port }),
    SCUM_MASTER_TIMEOUT_MS,
  );
  try {
    await writeScumTcp(conn, SCUM_MASTER_QUERY);
    const header = await readScumTcp(conn, SCUM_MASTER_RESPONSE_HEADER_SIZE);
    const responseLength = readUInt32LE(header, 0);
    if (responseLength > SCUM_MASTER_MAX_RESPONSE_BYTES) {
      throw new Error(
        `Ungültige SCUM-Masterantwort: ${responseLength} Bytes (Maximum ${SCUM_MASTER_MAX_RESPONSE_BYTES}).`,
      );
    }
    const payload = await readScumTcp(conn, responseLength);
    const records = parseScumMasterRecords(payload);
    if (records.length > SCUM_MASTER_MAX_RECORDS) {
      throw new Error(
        `Ungültige SCUM-Serveranzahl: ${records.length} (Maximum ${SCUM_MASTER_MAX_RECORDS}).`,
      );
    }
    return records;
  } finally {
    conn.close();
  }
}

async function resolveScumIp(host: string): Promise<string> {
  const normalized = host.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return normalized;
  const addresses = await timeout(
    Deno.resolveDns(normalized, "A"),
    SCUM_MASTER_TIMEOUT_MS,
  );
  if (!addresses[0]) {
    throw new Error("Keine IPv4-Adresse für den SCUM-Host gefunden.");
  }
  return addresses[0];
}

async function queryScumViaMaster(
  host: string,
  port: number,
): Promise<QueryResult> {
  const started = performance.now();
  const targetIp = await resolveScumIp(host);
  const candidatePorts = new Set([
    port,
    port + 1,
    port + 2,
    port + 3,
    port - 1,
    port - 2,
    port - 3,
  ].filter((candidate) => candidate >= 1 && candidate <= 65535));
  const matches: ScumMasterRecord[] = [];
  const errors: string[] = [];
  const masterResults = await Promise.allSettled(
    scumMasterServers().map(([masterHost, masterPort]) =>
      queryScumMaster(masterHost, masterPort)
    ),
  );
  for (const result of masterResults) {
    if (result.status === "fulfilled") {
      matches.push(...result.value.filter((record) => record.ip === targetIp));
    } else {
      errors.push(
        result.reason instanceof Error
          ? result.reason.message
          : "Netzwerkfehler",
      );
    }
  }
  const unique = [
    ...new Map(matches.map((record) => [record.port, record])).values(),
  ];
  const record = unique.find((item) => candidatePorts.has(item.port)) ??
    (unique.length === 1 ? unique[0] : undefined);
  if (!record) {
    throw new AdapterError(
      errors.length === scumMasterServers().length
        ? "Keine Antwort von den konfigurierten SCUM-Masterservern. SCUM stellt kein verlässliches direktes Query-Interface bereit; der Status wird über die Masterserverliste ermittelt."
        : errors.length > 0 && matches.length === 0
        ? "SCUM-Masterserver antworten, enthalten diese Ziel-IP aber nicht."
        : unique.length > 1
        ? "SCUM-Server gefunden, aber mehrere Ports gemeldet: " +
          unique.map((item) => item.port).join(", ") + "."
        : "Der SCUM-Server wurde noch nicht in der SCUM-Serverliste registriert.",
      "scum_master_unavailable",
    );
  }
  const masterLatencyMs = Math.round(performance.now() - started);
  return {
    online: true,
    transport: "SCUM Query (Masterserver)",
    target: displayTarget(host, port),
    latencyMs: masterLatencyMs,
    serverPingMs: Number.isFinite(record.serverPingMs)
      ? Math.round(record.serverPingMs)
      : undefined,
    message: "Der SCUM-Server antwortet über die SCUM-Serverliste.",
    fields: {
      "Servername": record.name,
      "Spieler": record.players,
      "Maximale Spieler": record.maxPlayers,
      "Server-Ping": Number.isFinite(record.serverPingMs)
        ? Math.round(record.serverPingMs)
        : undefined,
      "TPS": Number.isFinite(record.tps)
        ? Number(record.tps.toFixed(3))
        : undefined,
      "Masterserver-Abfrage": masterLatencyMs,
      "Gemeldeter SCUM-Port": record.port,
      "SCUM-IP": record.ip,
    },
    warnings: record.port === port ? undefined : [
      "Der SCUM-Masterserver meldet den Server unter Port " + record.port +
      "; der eingegebene Port war " + port + ".",
    ],
  };
}
type ScumMetricsCacheEntry = {
  etag?: string;
  result: QueryResult;
  expiresAt: number;
};

const SCUMMETRICS_API_BASE = Deno.env.get("SCUMMETRICS_API_BASE_URL")?.trim() ||
  "https://scummetrics.com/api/v1/servers";
const SCUMMETRICS_TIMEOUT_MS = 5_000;
const SCUMMETRICS_MIN_INTERVAL_MS = 500;
const scumMetricsCache = new Map<string, ScumMetricsCacheEntry>();
let scumMetricsNextRequestAt = 0;

async function waitForScumMetricsSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, scumMetricsNextRequestAt - now);
  scumMetricsNextRequestAt = Math.max(now, scumMetricsNextRequestAt) +
    SCUMMETRICS_MIN_INTERVAL_MS;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function scumMetricsErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

async function queryScumMetrics(
  host: string,
  port: number,
): Promise<QueryResult> {
  const started = performance.now();
  const target = `${host.replace(/^\\[|\\]$/g, "")}:${port}`;
  const cached = scumMetricsCache.get(target);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.result,
      latencyMs: Math.round(performance.now() - started),
      message: "Der SCUM-Server antwortet über SCUMetrics (Cache).",
    };
  }
  await waitForScumMetricsSlot();
  const headers = new Headers({ accept: "application/json" });
  if (cached?.etag) headers.set("if-none-match", cached.etag);
  const url = `${SCUMMETRICS_API_BASE}/${encodeURIComponent(target)}`;
  let response: Response;
  try {
    response = await timeout(fetch(url, { headers }), SCUMMETRICS_TIMEOUT_MS);
  } catch (error) {
    throw new AdapterError(
      `SCUMetrics ist nicht erreichbar: ${
        error instanceof Error ? error.message : "Netzwerkfehler"
      }`,
      "scum_metrics_unavailable",
    );
  }
  if (response.status === 304 && cached) {
    const refreshed = {
      ...cached,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    scumMetricsCache.set(target, refreshed);
    return {
      ...cached.result,
      latencyMs: Math.round(performance.now() - started),
      message: "Der SCUM-Server antwortet über SCUMetrics (unverändert).",
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after") ?? "unbekannt";
    throw new AdapterError(
      `SCUMetrics Rate-Limit erreicht; erneut versuchen nach ${retryAfter} Sekunden.`,
      "scum_metrics_rate_limited",
      429,
    );
  }
  if (!response.ok) {
    throw new AdapterError(
      `SCUMetrics: ${scumMetricsErrorMessage(body, `HTTP ${response.status}`)}`,
      response.status === 404 ? "scum_metrics_not_found" : "scum_metrics_error",
      response.status === 404 ? 404 : 502,
    );
  }
  const data = body && typeof body === "object"
    ? (body as Record<string, unknown>).data
    : undefined;
  if (!data || typeof data !== "object") {
    throw new AdapterError(
      "SCUMetrics lieferte keine gültigen Serverdaten.",
      "scum_metrics_invalid_response",
    );
  }
  const server = data as Record<string, unknown>;
  const address = server.address && typeof server.address === "object"
    ? server.address as Record<string, unknown>
    : {};
  const players = server.players && typeof server.players === "object"
    ? server.players as Record<string, unknown>
    : {};
  const location = server.location && typeof server.location === "object"
    ? server.location as Record<string, unknown>
    : {};
  const ranks = server.ranks && typeof server.ranks === "object"
    ? server.ranks as Record<string, unknown>
    : {};
  const status = server.status === "online";
  const result: QueryResult = {
    online: status,
    transport: "SCUMetrics API (Masterserver-Daten)",
    target: displayTarget(host, port),
    latencyMs: Math.round(performance.now() - started),
    message: status
      ? "Der SCUM-Server antwortet über SCUMetrics."
      : "SCUMetrics kennt den Server, meldet ihn aber nicht als online.",
    fields: {
      "Servername": server.name as FieldValue,
      "Spieler": players.current as FieldValue,
      "Maximale Spieler": players.max as FieldValue,
      "Version": server.version as FieldValue,
      "Build": server.build as FieldValue,
      "Spielmodus": server.mode as FieldValue,
      "Land": location.country as FieldValue,
      "Region": location.region as FieldValue,
      "Ingame-Zeit": server.ingame_time as FieldValue,
      "TPS": server.tps as FieldValue,
      "Durchschnitt Spieler (72h)": server.avg_players_72h as FieldValue,
      "Uptime (7 Tage)": server.uptime && typeof server.uptime === "object"
        ? (server.uptime as Record<string, unknown>)["7d"] as FieldValue
        : undefined,
      "Uptime (30 Tage)": server.uptime && typeof server.uptime === "object"
        ? (server.uptime as Record<string, unknown>)["30d"] as FieldValue
        : undefined,
      "DACH-Rang": ranks.dach && typeof ranks.dach === "object"
        ? `${(ranks.dach as Record<string, unknown>).rank ?? "-"} / ${
          (ranks.dach as Record<string, unknown>).of ?? "-"
        }`
        : undefined,
      "Weltrang": ranks.world && typeof ranks.world === "object"
        ? `${(ranks.world as Record<string, unknown>).rank ?? "-"} / ${
          (ranks.world as Record<string, unknown>).of ?? "-"
        }`
        : undefined,
      "SCUM-IP": address.ip as FieldValue,
      "Gemeldeter SCUM-Port": address.port as FieldValue,
      "SCUMetrics-ID": server.id as FieldValue,
      "Letzte Aktualisierung": (body as Record<string, unknown>).meta &&
          typeof (body as Record<string, unknown>).meta === "object"
        ? ((body as Record<string, unknown>).meta as Record<string, unknown>)
          .collected_at as FieldValue
        : undefined,
    },
  };
  const meta = body && typeof body === "object"
    ? (body as Record<string, unknown>).meta
    : undefined;
  const nextUpdate = meta && typeof meta === "object"
    ? (meta as Record<string, unknown>).next_update_at
    : undefined;
  const expiresAt = typeof nextUpdate === "string"
    ? Math.max(Date.now() + 30_000, Date.parse(nextUpdate))
    : Date.now() + 5 * 60 * 1000;
  scumMetricsCache.set(target, {
    etag: response.headers.get("etag") ?? undefined,
    result,
    expiresAt,
  });
  return result;
}
async function queryScumDirect(
  host: string,
  port: number,
): Promise<QueryResult> {
  const candidates = [
    ...new Set([
      port,
      port + 2,
      port + 1,
      port - 1,
      port - 2,
      port - 3,
    ].filter((candidate) => candidate >= 1 && candidate <= 65535)),
  ];
  try {
    return await Promise.any(
      candidates.map(async (candidate) => {
        const result = await queryScumA2s(host, candidate);
        if (candidate !== port) {
          result.warnings = [
            "SCUM hat auf dem eingegebenen Port nicht geantwortet; " +
            "die direkte A2S-Antwort wurde auf Port " + candidate +
            " empfangen.",
          ];
        }
        return result;
      }),
    );
  } catch {
    // All direct SCUM port variants failed.
  }
  throw new AdapterError(
    "Keine direkte SCUM-A2S-Antwort auf den geprüften Portvarianten.",
    "scum_a2s_unavailable",
  );
}

async function queryScum(
  host: string,
  port: number,
): Promise<QueryResult> {
  // The masterserver is authoritative for this adapter. SCUMetrics remains a
  // fallback, but its cache must not bypass a fresh masterserver check.
  let masterMessage = "Keine Masterserver-Antwort";
  try {
    // Primär: eigener SCUM-Masterserver-Client.
    return await queryScumViaMaster(host, port);
  } catch (error) {
    masterMessage = error instanceof Error
      ? error.message
      : "Keine Masterserver-Antwort";
  }

  let directMessage = "Keine direkte Antwort";
  try {
    // Fallback: einzelne Server-Query, falls der Server A2S anbietet.
    return await queryScumDirect(host, port);
  } catch (error) {
    directMessage = error instanceof Error
      ? error.message
      : "Keine direkte Antwort";
  }

  try {
    // Letzter Fallback: externe, read-only SCUMetrics-Datenquelle.
    return await queryScumMetrics(host, port);
  } catch (metricsError) {
    const metricsMessage = metricsError instanceof Error
      ? metricsError.message
      : "Keine SCUMetrics-Antwort";
    throw new AdapterError(
      "SCUM nicht erreichbar. Masterserver: " + masterMessage +
        " Direkte Abfrage: " + directMessage +
        " SCUMetrics-Fallback: " + metricsMessage,
      "scum_unavailable",
    );
  }
}
export async function querySpecial(
  protocol: Exclude<
    QueryProtocol,
    "auto" | "a2s" | "minecraft-java" | "minecraft-bedrock"
  >,
  host: string,
  port: number,
): Promise<QueryResult> {
  if (protocol === "satisfactory") return querySatisfactory(host, port);
  if (protocol === "fivem") return queryFiveM(host, port);
  if (protocol === "scum") return queryScum(host, port);
  return queryPalworldRest(host, port);
}

function rconPacket(id: number, type: number, body: string): Uint8Array {
  const payload = encoder.encode(body);
  const length = 4 + 4 + payload.length + 2;
  const result = new Uint8Array(4 + length);
  const view = new DataView(result.buffer);
  view.setInt32(0, length, true);
  view.setInt32(4, id, true);
  view.setInt32(8, type, true);
  result.set(payload, 12);
  return result;
}
async function readStreamPacket(
  conn: Deno.Conn,
): Promise<{ id: number; type: number; body: string }> {
  const lengthBytes = new Uint8Array(4);
  let offset = 0;
  while (offset < 4) {
    const read = await conn.read(lengthBytes.subarray(offset));
    if (read === null) throw new Error("Verbindung vorzeitig beendet.");
    offset += read;
  }
  const length = new DataView(lengthBytes.buffer).getInt32(0, true);
  if (length < 10 || length > 1_048_576) {
    throw new Error("Ungültige RCON-Paketgröße.");
  }
  const body = new Uint8Array(length);
  offset = 0;
  while (offset < length) {
    const read = await conn.read(body.subarray(offset));
    if (read === null) throw new Error("Verbindung vorzeitig beendet.");
    offset += read;
  }
  const view = new DataView(body.buffer);
  return {
    id: view.getInt32(0, true),
    type: view.getInt32(4, true),
    body: decoder.decode(body.subarray(8, length - 2)),
  };
}
async function executeSourceRcon(
  host: string,
  port: number,
  password: string,
  command: string,
  protocol: string,
): Promise<RconResult> {
  const started = performance.now();
  let conn: Deno.TcpConn | undefined;
  try {
    conn = await timeout(
      Deno.connect({ hostname: host, port }),
      RCON_TIMEOUT_MS,
    );
    const writeAll = async (data: Uint8Array) => {
      let offset = 0;
      while (offset < data.length) {
        offset += await conn!.write(data.subarray(offset));
      }
    };
    await writeAll(rconPacket(1, 3, password));
    const auth = await timeout(readStreamPacket(conn), RCON_TIMEOUT_MS);
    if (auth.id === -1) {
      throw new AdapterError(
        "RCON-Passwort wurde abgelehnt.",
        "rcon_auth_failed",
        401,
      );
    }
    await writeAll(rconPacket(2, 2, command));
    const chunks = [
      (await timeout(readStreamPacket(conn), RCON_TIMEOUT_MS)).body,
    ];
    while (true) {
      try {
        chunks.push((await timeout(readStreamPacket(conn), 250)).body);
      } catch {
        break;
      }
    }
    return {
      target: displayTarget(host, port),
      response: chunks.join(""),
      latencyMs: Math.round(performance.now() - started),
      protocol,
    };
  } finally {
    try {
      conn?.close();
    } catch { /* already closed */ }
  }
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function battleEyePacket(payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(8 + payload.length);
  result.set([0x42, 0x45], 0);
  new DataView(result.buffer).setUint32(2, crc32(payload), true);
  result[6] = 0xff;
  result.set(payload, 7);
  return result.subarray(0, 7 + payload.length);
}
async function executeBattlEye(
  host: string,
  port: number,
  password: string,
  command: string,
): Promise<RconResult> {
  const started = performance.now();
  const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
  const receive = () =>
    new Promise<Uint8Array>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off("message", onMessage);
        reject(error);
      };
      const onMessage = (message: Uint8Array) => {
        socket.off("error", onError);
        resolve(message);
      };
      socket.once("error", onError);
      socket.once("message", onMessage);
    });
  const send = (packet: Uint8Array) =>
    new Promise<void>((resolve, reject) =>
      socket.send(
        packet,
        port,
        host.replace(/^\\[|\\]$/g, ""),
        (error) => error ? reject(error) : resolve(),
      )
    );
  try {
    const login = await timeout(
      (async () => {
        await send(
          battleEyePacket(
            concatBytes(Uint8Array.from([0x00]), encoder.encode(password)),
          ),
        );
        return await receive();
      })(),
      RCON_TIMEOUT_MS,
    );
    if (login.length < 9 || login[7] !== 0x00 || login[8] !== 0x01) {
      throw new AdapterError(
        "BattlEye-RCon-Anmeldung wurde abgelehnt.",
        "rcon_auth_failed",
        401,
      );
    }
    await send(
      battleEyePacket(
        concatBytes(Uint8Array.from([0x01, 0x00]), encoder.encode(command)),
      ),
    );
    const response = await timeout(receive(), RCON_TIMEOUT_MS);
    const body = response.length > 9
      ? decoder.decode(response.subarray(9))
      : "";
    return {
      target: displayTarget(host, port),
      response: body,
      latencyMs: Math.round(performance.now() - started),
      protocol: "BattlEye RCon (UDP)",
    };
  } finally {
    try {
      socket.close();
    } catch { /* already closed */ }
  }
}

async function executeRustWebRcon(
  host: string,
  port: number,
  password: string,
  command: string,
): Promise<RconResult> {
  const started = performance.now();
  const socket = new WebSocket(`ws://${host}:${port}`);
  const response = await timeout(
    new Promise<string>((resolve, reject) => {
      let authenticated = false;
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            Identifier: -1,
            Message: password,
            Name: "WebRcon",
          }),
        ));
      socket.addEventListener("message", (event) => {
        try {
          const value = JSON.parse(String(event.data)) as Record<
            string,
            unknown
          >;
          if (!authenticated) {
            authenticated = true;
            socket.send(
              JSON.stringify({
                Identifier: 1,
                Message: command,
                Name: "WebRcon",
              }),
            );
            return;
          }
          resolve(
            typeof value.Message === "string"
              ? value.Message
              : JSON.stringify(value),
          );
        } catch (error) {
          reject(error);
        }
      });
      socket.addEventListener(
        "error",
        () => reject(new Error("WebSocket-Verbindung fehlgeschlagen.")),
      );
    }),
    RCON_TIMEOUT_MS,
  ).finally(() => socket.close());
  return {
    target: displayTarget(host, port),
    response,
    latencyMs: Math.round(performance.now() - started),
    protocol: "Rust WebRCON (WebSocket)",
  };
}

export async function executeRcon(
  protocol: RconProtocol,
  host: string,
  port: number,
  password: string,
  command: string,
): Promise<RconResult> {
  if (protocol === "battlEye-rcon") {
    return executeBattlEye(host, port, password, command);
  }
  if (protocol === "rust-websocket") {
    return executeRustWebRcon(host, port, password, command);
  }
  return executeSourceRcon(host, port, password, command, "Source RCON (TCP)");
}

export const queryAdapterInfo = [
  {
    id: "a2s",
    name: "A2S / Steam Query",
    transport: "UDP",
    status: "built-in",
    games:
      "Viele Valve-/Steam-Spiele, Arma 3, Arma Reforger, DayZ, Project Zomboid, Path of Titans und weitere",
  },
  {
    id: "minecraft-java",
    name: "Minecraft Java Status",
    transport: "TCP",
    status: "built-in",
    games: "Minecraft Java",
  },
  {
    id: "minecraft-bedrock",
    name: "Minecraft Bedrock RakNet",
    transport: "UDP",
    status: "built-in",
    games: "Minecraft Bedrock",
  },
  {
    id: "satisfactory",
    name: "Satisfactory Lightweight Query",
    transport: "UDP",
    status: "built-in",
    games: "Satisfactory",
  },
  {
    id: "fivem",
    name: "FiveM HTTP Query",
    transport: "HTTP",
    status: "built-in",
    games: "FiveM",
  },
  {
    id: "palworld-rest",
    name: "Palworld REST API",
    transport: "HTTP",
    status: "built-in",
    games: "Palworld Dedicated Server mit aktivierter REST API",
  },
  {
    id: "scum",
    name: "SCUM Query",
    transport: "TCP (Masterserver), optional UDP",
    status: "built-in",
    games:
      "SCUM Dedicated Server über die SCUM-Masterserverliste; direkte A2S-Prüfung nur als optionaler Fallback",
  },
];
export const rconAdapterInfo = [
  {
    id: "source-rcon",
    name: "Source RCON",
    transport: "TCP",
    status: "built-in",
    games:
      "Path of Titans, Minecraft Java, Palworld (falls angeboten), Project Zomboid, Factorio, Eco und weitere kompatible Server",
  },
  {
    id: "battlEye-rcon",
    name: "BattlEye RCon",
    transport: "UDP",
    status: "built-in",
    games: "Arma 3, DayZ und Arma Reforger",
  },
  {
    id: "rust-websocket",
    name: "Rust WebRCON",
    transport: "WebSocket",
    status: "built-in",
    games: "Rust",
  },
];
