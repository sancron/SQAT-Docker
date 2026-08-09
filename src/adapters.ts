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
      transport: "SCUM Query (A2S / Steam Query über UDP)",
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

const SCUM_MASTER_SERVERS: ReadonlyArray<[string, number]> = [
  ["176.57.138.2", 1040],
  ["172.107.16.215", 1040],
  ["206.189.248.133", 1040],
];
const SCUM_MASTER_TIMEOUT_MS = 5_000;
const SCUM_MASTER_RECORD_SIZE = 127;

type ScumMasterRecord = {
  ip: string;
  port: number;
  name: string;
  players: number;
  maxPlayers: number;
  password: boolean;
  version: string;
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
  for (
    let offset = 0;
    offset + SCUM_MASTER_RECORD_SIZE <= data.length;
    offset += SCUM_MASTER_RECORD_SIZE
  ) {
    const versionBytes = Array.from(
      data.subarray(offset + 119, offset + 127),
    ).reverse();
    const version = [
      versionBytes[0],
      versionBytes[1],
      Number.parseInt(
        versionBytes.slice(2, 4).map((value) =>
          value.toString(16).padStart(2, "0")
        ).join(""),
        16,
      ),
      Number.parseInt(
        versionBytes.slice(4).map((value) =>
          value.toString(16).padStart(2, "0")
        ).join(""),
        16,
      ),
    ].join(".");
    records.push({
      ip: [data[offset + 3], data[offset + 2], data[offset + 1], data[offset]]
        .join("."),
      port: data[offset + 4] | data[offset + 5] << 8,
      name: decoder.decode(data.subarray(offset + 6, offset + 106)).replace(
        /\0+$/g,
        "",
      ).trim(),
      players: data[offset + 107],
      maxPlayers: data[offset + 108],
      password: ((data[offset + 111] >> 1) & 1) === 1,
      version,
    });
  }
  return records;
}

async function queryScumMaster(
  host: string,
  port: number,
): Promise<ScumMasterRecord[]> {
  const conn = await timeout(
    Deno.connect({ hostname: host, port }),
    SCUM_MASTER_TIMEOUT_MS,
  );
  try {
    await writeScumTcp(conn, Uint8Array.from([0x04, 0x03, 0x00, 0x00]));
    const header = await readScumTcp(conn, 2);
    const count = header[0] | header[1] << 8;
    if (count > 100_000) throw new Error("Ungültige SCUM-Serveranzahl.");
    return parseScumMasterRecords(
      await readScumTcp(conn, count * SCUM_MASTER_RECORD_SIZE),
    );
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
    port + 2,
    port + 1,
    port - 1,
    port - 2,
    port - 3,
  ].filter((candidate) => candidate >= 1 && candidate <= 65535));
  const matches: ScumMasterRecord[] = [];
  const errors: string[] = [];
  for (const [masterHost, masterPort] of SCUM_MASTER_SERVERS) {
    try {
      const records = await queryScumMaster(masterHost, masterPort);
      matches.push(...records.filter((record) => record.ip === targetIp));
      if (matches.some((record) => candidatePorts.has(record.port))) break;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Netzwerkfehler");
    }
  }
  const unique = [
    ...new Map(matches.map((record) => [record.port, record])).values(),
  ];
  const record = unique.find((item) => candidatePorts.has(item.port)) ??
    (unique.length === 1 ? unique[0] : undefined);
  if (!record) {
    throw new AdapterError(
      errors.length > 0
        ? "SCUM-Masterserver sind aus der Tool-Umgebung nicht erreichbar."
        : unique.length > 1
        ? "SCUM-Server gefunden, aber mehrere Ports gemeldet: " +
          unique.map((item) => item.port).join(", ") + "."
        : "Der SCUM-Server wurde noch nicht in der SCUM-Serverliste registriert.",
      "scum_master_unavailable",
    );
  }
  return {
    online: true,
    transport: "SCUM Query (Masterserver)",
    target: displayTarget(host, port),
    latencyMs: Math.round(performance.now() - started),
    message: "Der SCUM-Server antwortet über die SCUM-Serverliste.",
    fields: {
      "Servername": record.name,
      "Spieler": record.players,
      "Maximale Spieler": record.maxPlayers,
      "Version": record.version,
      "Passwort geschützt": record.password,
      "Gemeldeter SCUM-Port": record.port,
      "SCUM-IP": record.ip,
    },
    warnings: record.port === port ? undefined : [
      "Der SCUM-Masterserver meldet den Server unter Port " + record.port +
      "; der eingegebene Port war " + port + ".",
    ],
  };
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
  for (const candidate of candidates) {
    try {
      const result = await queryScumA2s(host, candidate);
      if (candidate !== port) {
        result.warnings = [
          "SCUM hat auf dem eingegebenen Port nicht geantwortet; " +
          "die direkte A2S-Antwort wurde auf Port " + candidate + " empfangen.",
        ];
      }
      return result;
    } catch {
      // Try the next SCUM port variant.
    }
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
  const directPromise = queryScumDirect(host, port);
  const masterPromise = queryScumViaMaster(host, port);
  try {
    return await Promise.any([directPromise, masterPromise]);
  } catch {
    const [direct, master] = await Promise.allSettled([
      directPromise,
      masterPromise,
    ]);
    const directMessage = direct.status === "rejected" &&
        direct.reason instanceof Error
      ? direct.reason.message
      : "Keine direkte Antwort";
    const masterMessage = master.status === "rejected" &&
        master.reason instanceof Error
      ? master.reason.message
      : "Keine Masterserver-Antwort";
    throw new AdapterError(
      "SCUM nicht erreichbar. Direkte Abfrage: " + directMessage +
        " Masterserver: " + masterMessage,
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
    transport: "UDP / TCP",
    status: "built-in",
    games:
      "SCUM Dedicated Server über direkte A2S-Abfrage und SCUM-Masterserver",
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
