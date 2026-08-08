import { createSocket } from "node:dgram";
import {
  AdapterError,
  executeRcon as executeAdapterRcon,
  queryAdapterInfo,
  type QueryProtocol,
  querySpecial as querySpecialAdapter,
  rconAdapterInfo,
  type RconProtocol,
} from "./adapters.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PORT = Number.parseInt(Deno.env.get("PORT") ?? "8080", 10);
const SUPPORT_PASSWORD = Deno.env.get("SUPPORT_PASSWORD") ?? "";
const COOKIE_SECURE = Deno.env.get("COOKIE_SECURE") === "true";
const QUERY_TIMEOUT_MS = 2_000;
const RCON_TIMEOUT_MS = 3_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 30;
const requestLog = new Map<string, { count: number; resetAt: number }>();
const sessions = new Map<string, number>();

const A2S_INFO_REQUEST = Uint8Array.from([
  0xff,
  0xff,
  0xff,
  0xff,
  0x54,
  ...encoder.encode("Source Engine Query"),
  0x00,
]);
const BEDROCK_MAGIC = Uint8Array.from([
  0x00,
  0xff,
  0xff,
  0x00,
  0xfe,
  0xfe,
  0xfe,
  0xfe,
  0xfd,
  0xfd,
  0xfd,
  0xfd,
  0x12,
  0x34,
  0x56,
  0x78,
]);

type Transport = QueryProtocol;
type QueryRequest = { host: string; port: number; transport: Transport };
type FieldValue = string | number | boolean | null | undefined;
type QueryResult = {
  online: boolean;
  transport: string;
  target: string;
  latencyMs?: number;
  message: string;
  fields: Record<string, FieldValue>;
  players?: Array<Record<string, FieldValue>>;
  rules?: Array<{ key: string; value: string }>;
  attempts?: Array<{ transport: string; message: string }>;
};

class ToolError extends Error {
  status: number;
  code: string;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.status = status;
  }
}

function json(
  data: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[character] ?? character));
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isValidHost(value: string): boolean {
  if (
    value.length < 1 || value.length > 253 || value.includes("\\") ||
    /\s/.test(value)
  ) return false;
  const host = value.replace(/^\[|\]$/g, "");
  if (host.includes(":")) return /^[0-9a-f:]+$/i.test(host);
  if (isIPv4(host)) return true;
  return host.split(".").every((part) =>
    part.length > 0 && part.length <= 63 && /^[a-z0-9_-]+$/i.test(part)
  );
}

function targetHost(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}
function displayTarget(host: string, port: number): string {
  return host.includes(":") && !host.startsWith("[")
    ? `[${host}]:${port}`
    : `${host}:${port}`;
}

function validateQueryRequest(input: unknown): QueryRequest {
  if (!input || typeof input !== "object") {
    throw new ToolError("Ungültige Anfrage.", "invalid_request");
  }
  const body = input as Record<string, unknown>;
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const port = typeof body.port === "number"
    ? body.port
    : Number.parseInt(String(body.port ?? ""), 10);
  const transportValue = String(body.transport ?? "auto");
  const transport = [
      "auto",
      "a2s",
      "minecraft-java",
      "minecraft-bedrock",
      "satisfactory",
      "fivem",
      "palworld-rest",
    ].includes(
      transportValue,
    )
    ? transportValue as Transport
    : "auto";
  if (!isValidHost(host)) {
    throw new ToolError(
      "Bitte eine gültige IP-Adresse oder einen Hostnamen eingeben.",
      "invalid_host",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ToolError(
      "Der Port muss zwischen 1 und 65535 liegen.",
      "invalid_port",
    );
  }
  return { host, port, transport };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

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

function sendUdp(
  packet: Uint8Array,
  host: string,
  port: number,
  timeoutMs = QUERY_TIMEOUT_MS,
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
      socket.send(packet, port, targetHost(host), (error) => {
        if (error) onError(error);
      });
    }),
    timeoutMs,
  ).finally(() => {
    try {
      socket.close();
    } catch { /* already closed */ }
  });
}

function readCString(data: Uint8Array, offset: number): [string, number] {
  const end = data.indexOf(0, offset);
  if (end < 0) throw new Error("Unvollständige Serverantwort.");
  return [decoder.decode(data.subarray(offset, end)), end + 1];
}
function readUInt16LE(data: Uint8Array, offset: number): number {
  if (offset + 2 > data.length) {
    throw new Error("Unvollständige Serverantwort.");
  }
  return data[offset] | data[offset + 1] << 8;
}
function readInt32LE(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) {
    throw new Error("Unvollständige Serverantwort.");
  }
  return (data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 |
    data[offset + 3] << 24) >> 0;
}
function readFloatLE(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) {
    throw new Error("Unvollständige Serverantwort.");
  }
  return new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(
    0,
    true,
  );
}
function isA2sChallenge(data: Uint8Array): boolean {
  return data.length >= 9 && data[0] === 0xff && data[1] === 0xff &&
    data[2] === 0xff && data[3] === 0xff && data[4] === 0x41;
}

function parseA2sInfo(data: Uint8Array): Record<string, FieldValue> {
  if (
    data.length < 6 || data[0] !== 0xff || data[1] !== 0xff ||
    data[2] !== 0xff || data[3] !== 0xff || data[4] !== 0x49
  ) throw new Error("Keine gültige A2S_INFO-Antwort.");
  let offset = 6;
  const protocol = data[5];
  const [name, nameOffset] = readCString(data, offset);
  offset = nameOffset;
  const [map, mapOffset] = readCString(data, offset);
  offset = mapOffset;
  const [folder, folderOffset] = readCString(data, offset);
  offset = folderOffset;
  const [game, gameOffset] = readCString(data, offset);
  offset = gameOffset;
  const appId = readUInt16LE(data, offset);
  offset += 2;
  if (offset + 7 > data.length) {
    throw new Error("Unvollständige A2S_INFO-Antwort.");
  }
  const players = data[offset++];
  const maxPlayers = data[offset++];
  const bots = data[offset++];
  const serverTypeCode = data[offset++];
  const environmentCode = data[offset++];
  const visibility = data[offset++] === 0 ? "Öffentlich" : "Passwortgeschützt";
  const vac = data[offset++] === 1;
  const [version, versionOffset] = readCString(data, offset);
  offset = versionOffset;
  const fields: Record<string, FieldValue> = {
    "Protokollversion": protocol,
    "Servername": name,
    "Karte": map,
    "Ordner": folder,
    "Spiel": game,
    "App-ID": appId,
    "Spieler": players,
    "Maximale Spieler": maxPlayers,
    "Bots": bots,
    "Servertyp": serverTypeCode === 0x64
      ? "Dedicated"
      : serverTypeCode === 0x6c
      ? "Non-dedicated"
      : serverTypeCode === 0x70
      ? "SourceTV"
      : "Unbekannt",
    "Betriebssystem": environmentCode === 0x6c
      ? "Linux"
      : environmentCode === 0x77
      ? "Windows"
      : environmentCode === 0x6d
      ? "Mac"
      : "Unbekannt",
    "Zugriff": visibility,
    "VAC": vac ? "Aktiv" : "Nicht aktiv",
    "Serverversion": version,
  };
  // Optional EDF data is appended by many current Steam/A2S servers.
  if (offset < data.length) {
    const edf = data[offset++];
    if (edf & 0x80) {
      fields["Serverport"] = readUInt16LE(data, offset);
      offset += 2;
    }
    if (edf & 0x10) {
      if (offset + 8 > data.length) {
        throw new Error("Unvollständige A2S_STEAMID-Daten.");
      }
      fields["Steam-ID"] = new DataView(
        data.buffer,
        data.byteOffset + offset,
        8,
      ).getBigUint64(0, true).toString();
      offset += 8;
    }
    if (edf & 0x40) {
      fields["SourceTV-Port"] = readUInt16LE(data, offset);
      offset += 2;
      const [sourceTvName, sourceTvOffset] = readCString(data, offset);
      fields["SourceTV-Name"] = sourceTvName;
      offset = sourceTvOffset;
    }
    if (edf & 0x20) {
      const [keywords, keywordsOffset] = readCString(data, offset);
      fields["Schlagwörter"] = keywords;
      offset = keywordsOffset;
    }
    if (edf & 0x01) {
      if (offset + 8 > data.length) {
        throw new Error("Unvollständige A2S_GAMEID-Daten.");
      }
      fields["Game-ID"] = new DataView(
        data.buffer,
        data.byteOffset + offset,
        8,
      ).getBigUint64(0, true).toString();
    }
  }
  return fields;
}

function sendUdpOnSocket(
  socket: ReturnType<typeof createSocket>,
  packet: Uint8Array,
  host: string,
  port: number,
  timeoutMs = QUERY_TIMEOUT_MS,
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
      socket.send(packet, port, targetHost(host), (error) => {
        if (error) onError(error);
      });
    }),
    timeoutMs,
  );
}

async function a2sRequest(
  host: string,
  port: number,
  packet: Uint8Array,
): Promise<Uint8Array> {
  const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
  try {
    let response = await sendUdpOnSocket(socket, packet, host, port);
    // Some servers, including Path of Titans deployments, bind the challenge
    // to the originating UDP socket. Keep the same socket for the handshake.
    for (let attempt = 0; attempt < 2 && isA2sChallenge(response); attempt++) {
      response = await sendUdpOnSocket(
        socket,
        concatBytes(packet, response.subarray(5, 9)),
        host,
        port,
      );
    }
    if (isA2sChallenge(response)) {
      throw new Error("Der A2S-Challenge-Handshake wurde nicht akzeptiert.");
    }
    return response;
  } finally {
    try {
      socket.close();
    } catch { /* already closed */ }
  }
}

function parseA2sPlayers(data: Uint8Array): Array<Record<string, FieldValue>> {
  if (data.length < 6 || data[4] !== 0x44) {
    throw new Error("Keine gültige A2S_PLAYER-Antwort.");
  }
  const count = data[5];
  let offset = 6;
  const players: Array<Record<string, FieldValue>> = [];
  for (let i = 0; i < count; i++) {
    const index = data[offset++];
    const [name, next] = readCString(data, offset);
    offset = next;
    const score = readInt32LE(data, offset);
    offset += 4;
    const durationSeconds = readFloatLE(data, offset);
    offset += 4;
    players.push({
      "Index": index,
      "Name": name,
      "Punkte": score,
      "Spielzeit": `${Math.round(durationSeconds / 60)} min`,
    });
  }
  return players;
}

function parseA2sRules(
  data: Uint8Array,
): Array<{ key: string; value: string }> {
  if (data.length < 7 || data[4] !== 0x45) {
    throw new Error("Keine gültige A2S_RULES-Antwort.");
  }
  const count = readUInt16LE(data, 5);
  let offset = 7;
  const rules: Array<{ key: string; value: string }> = [];
  for (let i = 0; i < count; i++) {
    const [key, keyOffset] = readCString(data, offset);
    offset = keyOffset;
    const [value, valueOffset] = readCString(data, offset);
    offset = valueOffset;
    rules.push({ key, value });
  }
  return rules;
}

async function queryA2s(host: string, port: number): Promise<QueryResult> {
  const started = performance.now();
  let infoResponse: Uint8Array;
  try {
    infoResponse = await a2sRequest(host, port, A2S_INFO_REQUEST);
  } catch (error) {
    throw new ToolError(
      `Keine A2S-Antwort: ${
        error instanceof Error ? error.message : "Netzwerkfehler"
      }`,
      "a2s_unavailable",
      502,
    );
  }
  let fields: Record<string, FieldValue>;
  try {
    fields = parseA2sInfo(infoResponse);
  } catch (error) {
    throw new ToolError(
      `Ungültige A2S_INFO-Antwort: ${
        error instanceof Error ? error.message : "unbekannter Parserfehler"
      }`,
      "a2s_invalid_response",
      502,
    );
  }
  const playerPacket = Uint8Array.from([
    0xff,
    0xff,
    0xff,
    0xff,
    0x55,
    0xff,
    0xff,
    0xff,
    0xff,
  ]);
  const rulesPacket = Uint8Array.from([
    0xff,
    0xff,
    0xff,
    0xff,
    0x56,
    0xff,
    0xff,
    0xff,
    0xff,
  ]);
  const [playerResult, rulesResult] = await Promise.allSettled([
    a2sRequest(host, port, playerPacket).then(parseA2sPlayers),
    a2sRequest(host, port, rulesPacket).then(parseA2sRules),
  ]);
  const result: QueryResult = {
    online: true,
    transport: "A2S / Steam Query",
    target: displayTarget(host, port),
    latencyMs: Math.round(performance.now() - started),
    message: "Der Server antwortet auf A2S_INFO.",
    fields,
  };
  if (playerResult.status === "fulfilled") result.players = playerResult.value;
  if (rulesResult.status === "fulfilled") result.rules = rulesResult.value;
  const unavailable = [
    playerResult.status === "rejected" ? "A2S_PLAYER" : "",
    rulesResult.status === "rejected" ? "A2S_RULES" : "",
  ].filter(Boolean);
  if (unavailable.length) {
    result.message += ` ${
      unavailable.join(" und ")
    } wurde(n) vom Server nicht angeboten.`;
  }
  return result;
}

function encodeVarInt(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value >>> 0;
  do {
    let next = current & 0x7f;
    current >>>= 7;
    if (current) next |= 0x80;
    bytes.push(next);
  } while (current);
  return Uint8Array.from(bytes);
}
function encodeMcString(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  return concatBytes(encodeVarInt(bytes.length), bytes);
}
async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    offset += await conn.write(data.subarray(offset));
  }
}
async function readExact(conn: Deno.Conn, length: number): Promise<Uint8Array> {
  const result = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const read = await conn.read(result.subarray(offset));
    if (read === null) throw new Error("Verbindung vorzeitig beendet.");
    offset += read;
  }
  return result;
}
async function readVarInt(conn: Deno.Conn): Promise<number> {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const byte = (await readExact(conn, 1))[0];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value >>> 0;
    shift += 7;
  }
  throw new Error("Ungültige Minecraft-Paketlänge.");
}

async function queryMinecraftJava(
  host: string,
  port: number,
): Promise<QueryResult> {
  const started = performance.now();
  let conn: Deno.TcpConn | undefined;
  try {
    conn = await timeout(
      Deno.connect({ hostname: targetHost(host), port }),
      QUERY_TIMEOUT_MS,
    );
    const handshake = concatBytes(
      encodeVarInt(0),
      encodeVarInt(760),
      encodeMcString(targetHost(host)),
      Uint8Array.from([port >> 8, port & 0xff]),
      encodeVarInt(1),
    );
    await writeAll(
      conn,
      concatBytes(
        encodeVarInt(handshake.length),
        handshake,
        Uint8Array.from([1, 0]),
      ),
    );
    const length = await timeout(readVarInt(conn), QUERY_TIMEOUT_MS);
    if (length > 1_000_000) throw new Error("Antwort ist zu groß.");
    const packet = await timeout(readExact(conn, length), QUERY_TIMEOUT_MS);
    if (packet[0] !== 0) throw new Error("Ungültige Statusantwort.");
    let offset = 1;
    let jsonLength = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const byte = packet[offset++];
      jsonLength |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    const status = JSON.parse(
      decoder.decode(packet.subarray(offset, offset + jsonLength)),
    ) as Record<string, unknown>;
    const version = (status.version ?? {}) as Record<string, unknown>;
    const players = (status.players ?? {}) as Record<string, unknown>;
    return {
      online: true,
      transport: "Minecraft Java Server List Ping",
      target: displayTarget(host, port),
      latencyMs: Math.round(performance.now() - started),
      message: "Der Minecraft-Java-Server antwortet auf den Status-Ping.",
      fields: {
        "MOTD": typeof status.description === "string"
          ? status.description
          : JSON.stringify(status.description ?? ""),
        "Version": version.name as FieldValue,
        "Protokollversion": version.protocol as FieldValue,
        "Spieler": players.online as FieldValue,
        "Maximale Spieler": players.max as FieldValue,
        "Favicon vorhanden": typeof status.favicon === "string",
        "Zusatzdaten": JSON.stringify(status),
      },
    };
  } catch (error) {
    throw new ToolError(
      `Keine Minecraft-Java-Antwort: ${
        error instanceof Error ? error.message : "Netzwerkfehler"
      }`,
      "minecraft_java_unavailable",
      502,
    );
  } finally {
    try {
      conn?.close();
    } catch { /* already closed */ }
  }
}

function uint64Bytes(value: number): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, BigInt(value), true);
  return result;
}
async function queryMinecraftBedrock(
  host: string,
  port: number,
): Promise<QueryResult> {
  const started = performance.now();
  const packet = concatBytes(
    Uint8Array.from([0x01]),
    uint64Bytes(Date.now()),
    BEDROCK_MAGIC,
    uint64Bytes(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
  );
  try {
    const response = await sendUdp(packet, host, port);
    if (response.length < 35 || response[0] !== 0x1c) {
      throw new Error("Keine gültige RakNet-Pong-Antwort.");
    }
    const parts = decoder.decode(response.subarray(35)).split(";");
    return {
      online: true,
      transport: "Minecraft Bedrock / RakNet",
      target: displayTarget(host, port),
      latencyMs: Math.round(performance.now() - started),
      message: "Der Minecraft-Bedrock-Server antwortet auf den RakNet-Ping.",
      fields: {
        "Edition": parts[0],
        "MOTD": parts[1],
        "Protokollversion": parts[2],
        "Version": parts[3],
        "Spieler": parts[4] ? Number(parts[4]) : undefined,
        "Maximale Spieler": parts[5] ? Number(parts[5]) : undefined,
        "Welt": parts[7],
        "Spielmodus": parts[8],
        "IPv4-Port": parts[10],
        "IPv6-Port": parts[11],
      },
    };
  } catch (error) {
    throw new ToolError(
      `Keine Minecraft-Bedrock-Antwort: ${
        error instanceof Error ? error.message : "Netzwerkfehler"
      }`,
      "minecraft_bedrock_unavailable",
      502,
    );
  }
}

async function queryServer(request: QueryRequest): Promise<QueryResult> {
  if (["satisfactory", "fivem", "palworld-rest"].includes(request.transport)) {
    return querySpecialAdapter(
      request.transport as Exclude<
        QueryProtocol,
        "auto" | "a2s" | "minecraft-java" | "minecraft-bedrock"
      >,
      request.host,
      request.port,
    );
  }
  if (request.transport === "a2s") return queryA2s(request.host, request.port);
  if (request.transport === "minecraft-java") {
    return queryMinecraftJava(request.host, request.port);
  }
  if (request.transport === "minecraft-bedrock") {
    return queryMinecraftBedrock(request.host, request.port);
  }
  const attempts: Array<{ transport: string; message: string }> = [];
  const probes = [
    ["A2S / Steam Query", () => queryA2s(request.host, request.port)],
    ["Minecraft Java", () => queryMinecraftJava(request.host, request.port)],
    [
      "Minecraft Bedrock",
      () => queryMinecraftBedrock(request.host, request.port),
    ],
    [
      "Satisfactory Lightweight Query",
      () => querySpecialAdapter("satisfactory", request.host, request.port),
    ],
    [
      "FiveM HTTP Query",
      () => querySpecialAdapter("fivem", request.host, request.port),
    ],
    [
      "Palworld REST API",
      () => querySpecialAdapter("palworld-rest", request.host, request.port),
    ],
  ] as const;
  for (const [transport, probe] of probes) {
    try {
      const result = await probe();
      result.attempts = attempts;
      return result;
    } catch (error) {
      attempts.push({
        transport,
        message: error instanceof Error ? error.message : "Keine Antwort",
      });
    }
  }
  throw new ToolError(
    "Keines der automatischen Query-Protokolle hat eine verwertbare Antwort geliefert.",
    "no_supported_query",
    502,
  );
}

function clientAddress(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown";
}
function checkRateLimit(request: Request): void {
  const key = clientAddress(request);
  const now = Date.now();
  const current = requestLog.get(key);
  if (!current || current.resetAt <= now) {
    requestLog.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  if (current.count >= MAX_REQUESTS_PER_MINUTE) {
    throw new ToolError(
      "Zu viele Prüfungen. Bitte in einer Minute erneut versuchen.",
      "rate_limited",
      429,
    );
  }
  current.count++;
}
function cookieValue(request: Request, name: string): string | undefined {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function authenticated(request: Request): boolean {
  const token = cookieValue(request, "support_session");
  const expires = token ? sessions.get(token) : undefined;
  if (!token || !expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}
async function passwordMatches(candidate: string): Promise<boolean> {
  if (!SUPPORT_PASSWORD) return false;
  const [candidateHash, passwordHash] = await Promise.all(
    [candidate, SUPPORT_PASSWORD].map((value) =>
      crypto.subtle.digest("SHA-256", encoder.encode(value))
    ),
  );
  const left = new Uint8Array(candidateHash);
  const right = new Uint8Array(passwordHash);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
function requireAuth(request: Request): void {
  if (!authenticated(request)) {
    throw new ToolError("Anmeldung erforderlich.", "unauthorized", 401);
  }
}

function styles(): string {
  return `<style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0d1219;color:#edf4f8}*{box-sizing:border-box}body{min-height:100vh;margin:0;background:radial-gradient(circle at 15% 0,#19353d 0,#0d1219 48%);padding:24px}.shell{width:min(100%,1180px);margin:0 auto}.narrow{width:min(100%,600px);min-height:calc(100vh - 48px);display:grid;place-items:center}.panel{border:1px solid #2a404b;border-radius:22px;background:rgba(17,26,35,.95);box-shadow:0 22px 70px #0005;padding:clamp(22px,4vw,40px)}.eyebrow{margin:0 0 10px;color:#72d0ad;font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.muted{color:#aebcc6;line-height:1.6}.error{color:#f29b9b;min-height:1.4em}.stack{display:grid;gap:16px}label{display:grid;gap:8px;color:#d9e5ec;font-size:.9rem;font-weight:700}input,select,textarea,button{width:100%;min-height:46px;padding:0 13px;border:1px solid #3a505d;border-radius:10px;background:#101a23;color:#edf4f8;font:inherit}textarea{padding-top:12px;min-height:120px;resize:vertical}button{border:0;background:#72d0ad;color:#0b1715;cursor:pointer;font-weight:800}button:disabled{opacity:.65;cursor:wait}button.secondary{background:#243541;color:#d8e7ed;border:1px solid #3d5664}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:20px 0}.topbar h1{margin:0;font-size:clamp(1.5rem,4vw,2.35rem)}.topbar button{width:auto;padding:0 16px}.tabs{display:flex;gap:8px;margin:0 0 18px}.tabs button{width:auto;background:#182731;color:#aebdc6}.tabs button.active{background:#72d0ad;color:#0b1715}.tab{display:none}.tab.active{display:block}.form-grid{display:grid;grid-template-columns:1fr 180px;gap:14px}.form-grid.three{grid-template-columns:1fr 180px 220px}.result{margin-top:24px;border-top:1px solid #2a404b;padding-top:22px}.status{font-weight:850}.online{color:#72d0ad}.offline,.warning{color:#f29b9b}.checking{color:#e8c477}.meta{color:#96a9b4}.details{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:18px}.detail{padding:13px 14px;border-radius:10px;background:#101a23;overflow-wrap:anywhere}.detail small{display:block;margin-bottom:5px;color:#81949f}.section{margin-top:20px}.section h3{margin:0 0 10px;font-size:1rem}.table-wrap{overflow:auto;border:1px solid #2a404b;border-radius:10px}.table{width:100%;border-collapse:collapse;min-width:420px}.table th,.table td{text-align:left;padding:10px 12px;border-bottom:1px solid #263943}.table th{color:#9db2bd;font-size:.8rem}.raw{white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;padding:14px;border-radius:10px;background:#0b1218;color:#c8d7df}.hint{margin:10px 0 0;color:#8fa4ae;font-size:.85rem}@media(max-width:700px){.form-grid,.form-grid.three{grid-template-columns:1fr}.topbar{align-items:flex-start;flex-direction:column}.topbar button{width:100%}}h1{line-height:1.08}</style>`;
}

function loginPage(): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Support Query Tool – Anmeldung</title>${styles()}</head><body><main class="shell narrow"><section class="panel"><p class="eyebrow">4Netplayers Support</p><h1>Support Query Tool</h1><p class="muted">Der Support-Bereich ist passwortgeschützt. Bitte melde dich an, um Serverabfragen und RCON zu verwenden.</p><form id="login-form" class="stack"><label>Support-Passwort<input id="password" type="password" autocomplete="current-password" required></label><button type="submit">Anmelden</button><p id="error" class="error" aria-live="polite"></p></form></section></main><script>document.querySelector('#login-form').addEventListener('submit',async(e)=>{e.preventDefault();const error=document.querySelector('#error');error.textContent='';const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.querySelector('#password').value})});const data=await response.json();if(response.ok){location.href='/';}else{error.textContent=data.message||'Anmeldung fehlgeschlagen.';}});</script></body></html>`;
}

function appScript(): string {
  return `const $=(s)=>document.querySelector(s);const escape=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.id==='tab-'+b.dataset.tab));}));$('#logout').addEventListener('click',async()=>{await fetch('/api/auth/logout',{method:'POST'});location.href='/';});function detailCards(fields){return Object.entries(fields||{}).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>'<div class="detail"><small>'+escape(k)+'</small><span>'+escape(typeof v==='object'?JSON.stringify(v):v)+'</span></div>').join('');}function table(rows){if(!rows?.length)return '<p class="hint">Der Server hat keine Einträge geliefert.</p>';const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];return '<div class="table-wrap"><table class="table"><thead><tr>'+keys.map(k=>'<th>'+escape(k)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+keys.map(k=>'<td>'+escape(r[k])+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}function showQuery(data){const online=data.online;let html='<div><span class="status '+(online?'online':'offline')+'">'+(online?'Online':'Nicht erreichbar')+'</span> <span class="meta">'+escape(data.transport||'')+(data.latencyMs?' · '+data.latencyMs+' ms':'')+'</span></div><p class="muted">'+escape(data.message)+'</p>';if(data.fields)html+='<div class="details">'+detailCards(data.fields)+'</div>';if(data.players)html+='<div class="section"><h3>Spieler ('+data.players.length+')</h3>'+table(data.players)+'</div>';if(data.rules)html+='<div class="section"><h3>Regeln ('+data.rules.length+')</h3>'+table(data.rules.map(x=>({Schlüssel:x.key,Wert:x.value})))+'</div>';if(data.warnings?.length)html+='<div class="section"><h3>Adapter-Hinweise</h3>'+table(data.warnings.map(x=>({Hinweis:x})))+'</div>';if(data.attempts?.length)html+='<div class="section"><h3>Automatische Versuche</h3>'+table(data.attempts.map(x=>({Protokoll:x.transport,Ergebnis:x.message})))+'</div>';$('#query-result').innerHTML=html;$('#query-result').classList.add('visible');}$('#query-form').addEventListener('submit',async e=>{e.preventDefault();const button=$('#query-submit');button.disabled=true;button.textContent='Abfrage läuft …';$('#query-result').classList.add('visible');$('#query-result').innerHTML='<span class="status checking">Prüfung läuft …</span>';try{const r=await fetch('/api/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({host:$('#query-host').value.trim(),port:Number($('#query-port').value),transport:$('#query-transport').value})});showQuery(await r.json());}catch{$('#query-result').innerHTML='<span class="status offline">Anfrage fehlgeschlagen</span>';}finally{button.disabled=false;button.textContent='Server abfragen';}});$('#rcon-form').addEventListener('submit',async e=>{e.preventDefault();const button=$('#rcon-submit');button.disabled=true;button.textContent='Sende …';$('#rcon-result').classList.add('visible');$('#rcon-result').innerHTML='<span class="status checking">Verbinde mit RCON …</span>';try{const r=await fetch('/api/rcon',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({host:$('#rcon-host').value.trim(),port:Number($('#rcon-port').value),protocol:$('#rcon-protocol').value,password:$('#rcon-password').value,command:$('#rcon-command').value})});const d=await r.json();$('#rcon-result').innerHTML='<div><span class="status '+(r.ok?'online':'offline')+'">'+(r.ok?'Antwort erhalten':'RCON-Fehler')+'</span> <span class="meta">'+escape(d.protocol||'')+' · '+escape(d.target||'')+(d.latencyMs?' · '+d.latencyMs+' ms':'')+'</span></div><p class="muted">'+escape(d.message||'')+'</p>'+(d.response!==undefined?'<div class="section"><h3>Serverausgabe</h3><pre class="raw">'+escape(d.response)+'</pre></div>':'');}catch{$('#rcon-result').innerHTML='<span class="status offline">RCON-Anfrage fehlgeschlagen</span>';}finally{button.disabled=false;button.textContent='Befehl senden';}});`;
}

function appPage(): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Universelles Support Query und RCON Tool"><title>Support Query Tool</title>${styles()}</head><body><main class="shell"><header class="topbar"><div><p class="eyebrow">4Netplayers Support</p><h1>Support Query Tool</h1></div><button id="logout" class="secondary">Abmelden</button></header><nav class="tabs" aria-label="Bereiche"><button class="active" data-tab="query">Server Query</button><button data-tab="rcon">RCON-Konsole</button></nav><section id="tab-query" class="panel tab active"><h2>Serverinformationen abrufen</h2><p class="muted">Wähle einen Adapter oder nutze „Automatisch“. Je nach Spiel werden alle Daten angezeigt, die das jeweilige Protokoll liefert.</p><form id="query-form" class="stack"><div class="form-grid three"><label>IP-Adresse / Hostname<input id="query-host" required placeholder="203.0.113.10 oder server.example"></label><label>Query-Port<input id="query-port" type="number" min="1" max="65535" value="27015" required></label><label>Query-Adapter<select id="query-transport"><option value="auto">Automatisch testen</option><option value="a2s">A2S / Steam Query (UDP)</option><option value="minecraft-java">Minecraft Java (TCP)</option><option value="minecraft-bedrock">Minecraft Bedrock / RakNet (UDP)</option><option value="satisfactory">Satisfactory Lightweight Query (UDP)</option><option value="fivem">FiveM HTTP Query</option><option value="palworld-rest">Palworld REST API (HTTP)</option></select></label></div><button id="query-submit" type="submit">Server abfragen</button></form><div id="query-result" class="result" aria-live="polite"></div><div class="muted"><strong>Hinweis:</strong> A2S ist für viele Steam-/Source-Server sowie häufig Arma 3, Arma Reforger, DayZ, Project Zomboid und Path of Titans geeignet. Spezialadapter decken Satisfactory, FiveM und Palworld REST ab. Aktivierung, Port und konkrete Daten hängen vom Server und Hosting-Setup ab.</div></section><section id="tab-rcon" class="panel tab"><h2>RCON-Befehl senden</h2><p class="muted">Wähle das zum Spiel passende RCON-Protokoll. RCON muss serverseitig aktiviert und aus dem Netzwerk erreichbar sein; Passwörter werden nur für die laufende Anfrage verwendet.</p><form id="rcon-form" class="stack"><div class="form-grid three"><label>IP-Adresse / Hostname<input id="rcon-host" required placeholder="203.0.113.10"></label><label>RCON-Port<input id="rcon-port" type="number" min="1" max="65535" value="27015" required></label><label>RCON-Adapter<select id="rcon-protocol"><option value="source-rcon">Source RCON / TCP (Path of Titans, Minecraft, Project Zomboid, Factorio, Eco …)</option><option value="battlEye-rcon">BattlEye / Bohemia RCon / UDP (Arma 3, DayZ, Arma Reforger)</option><option value="rust-websocket">Rust WebRCON / WebSocket</option></select></label></div><label>RCON-Passwort<input id="rcon-password" type="password" autocomplete="off" required></label><label>Befehl<textarea id="rcon-command" maxlength="512" required placeholder="status"></textarea><button id="rcon-submit" type="submit">Befehl senden</button></form><div id="rcon-result" class="result" aria-live="polite"></div></section></main><script>${appScript()}</script></body></html>`;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ToolError(
      "Die Anfrage enthält kein gültiges JSON.",
      "invalid_json",
    );
  }
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ status: "ok", configured: Boolean(SUPPORT_PASSWORD) });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request) as Record<string, unknown>;
    const password = typeof body.password === "string" ? body.password : "";
    if (!SUPPORT_PASSWORD) {
      return json({
        message: "SUPPORT_PASSWORD ist auf dem Server nicht gesetzt.",
      }, 503);
    }
    if (!(await passwordMatches(password))) {
      return json({ message: "Falsches Passwort." }, 401);
    }
    const token = crypto.randomUUID().replaceAll("-", "");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    const flags = [
      `support_session=${token}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${SESSION_TTL_MS / 1000}`,
    ];
    if (COOKIE_SECURE) flags.push("Secure");
    return json({ authenticated: true }, 200, {
      "set-cookie": flags.join("; "),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/auth/status") {
    return json({ authenticated: authenticated(request) });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return json({ authenticated: false }, 200, {
      "set-cookie":
        "support_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    });
  }
  if (request.method === "GET" && url.pathname === "/") {
    return authenticated(request)
      ? new Response(appPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
      : new Response(loginPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
  }
  if (request.method === "GET" && url.pathname === "/api/adapters") {
    requireAuth(request);
    return json({ query: queryAdapterInfo, rcon: rconAdapterInfo });
  }
  if (request.method === "POST" && url.pathname === "/api/query") {
    requireAuth(request);
    checkRateLimit(request);
    return json(
      await queryServer(validateQueryRequest(await readJson(request))),
    );
  }
  if (request.method === "POST" && url.pathname === "/api/rcon") {
    requireAuth(request);
    checkRateLimit(request);
    const body = await readJson(request) as Record<string, unknown>;
    const host = typeof body.host === "string" ? body.host.trim() : "";
    const port = Number(body.port);
    const password = typeof body.password === "string" ? body.password : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    const protocolValue = String(body.protocol ?? "source-rcon");
    const protocol: RconProtocol =
      ["source-rcon", "battlEye-rcon", "rust-websocket"].includes(protocolValue)
        ? protocolValue as RconProtocol
        : "source-rcon";
    if (!isValidHost(host)) {
      throw new ToolError(
        "Bitte eine gültige IP-Adresse oder einen Hostnamen eingeben.",
        "invalid_host",
      );
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ToolError("Der RCON-Port ist ungültig.", "invalid_port");
    }
    if (!password) {
      throw new ToolError(
        "Bitte ein RCON-Passwort eingeben.",
        "invalid_password",
      );
    }
    if (!command || command.length > 512) {
      throw new ToolError(
        "Der Befehl darf nicht leer und höchstens 512 Zeichen lang sein.",
        "invalid_command",
      );
    }
    try {
      return json({
        ...(await executeAdapterRcon(protocol, host, port, password, command)),
        message: "Der RCON-Befehl wurde gesendet.",
      });
    } catch (error) {
      if (error instanceof ToolError || error instanceof AdapterError) {
        throw error;
      }
      throw new ToolError(
        `RCON nicht erreichbar: ${
          error instanceof Error ? error.message : "Netzwerkfehler"
        }`,
        "rcon_unavailable",
        502,
      );
    }
  }
  throw new ToolError("Nicht gefunden.", "not_found", 404);
}

async function serve(request: Request): Promise<Response> {
  try {
    return await handle(request);
  } catch (error) {
    if (error instanceof ToolError || error instanceof AdapterError) {
      return json(
        { online: false, message: error.message, code: error.code },
        error.status,
      );
    }
    console.error(error);
    return json({
      online: false,
      message: "Interner Fehler.",
      code: "internal_error",
    }, 500);
  }
}

console.log(`Support Query Tool listening on :${PORT}`);
Deno.serve({ hostname: "0.0.0.0", port: PORT }, serve);
