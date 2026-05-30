/**
 * agent_hello — one-shot client self-report received on every player join.
 *
 * The Flutter client publishes one reliable data message on the `agent_hello`
 * topic immediately after `room.connect()` succeeds. It carries the actual
 * `ConnectOptions` the client is using plus SDK / build / version metadata.
 *
 * Why we care: `adaptiveStream: true` silently breaks Tech World video
 * forwarding (and can pause audio via SFU demand-signaling) because the
 * Flutter client renders frames through the Flame canvas instead of
 * `VideoTrackRenderer`. The publisher-side heuristic in PR #15 catches the
 * correlated symptom; this catches the genuine cause directly.
 *
 * No persistence — the log line IS the artifact.
 */

/** Schema versions this bot knows how to read. */
const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);

/** Shape of a v1 agent_hello payload. */
export interface AgentHelloPayloadV1 {
  schemaVersion: 1;
  clientSdk: string;
  clientSdkVersion: string;
  buildSha: string;
  appVersion: string;
  adaptiveStream: boolean;
  dynacast: boolean;
  platform: string;
  userAgent: string | null;
}

/** Result of parsing an agent_hello payload. */
export type ParseResult =
  | { ok: true; payload: AgentHelloPayloadV1 }
  | { ok: false; reason: string };

/**
 * Parse + validate a raw agent_hello payload (already JSON-decoded).
 *
 * Defensive — never throws. Unknown fields are tolerated; missing required
 * fields produce `{ ok: false }`. Unknown schemaVersion produces `{ ok: false }`
 * so the bot doesn't act on a future shape it can't reason about.
 */
export function parseAgentHello(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  const schemaVersion = obj.schemaVersion;
  if (typeof schemaVersion !== "number" || !SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    return { ok: false, reason: `unsupported schemaVersion: ${String(schemaVersion)}` };
  }
  if (
    typeof obj.clientSdk !== "string" ||
    typeof obj.clientSdkVersion !== "string" ||
    typeof obj.buildSha !== "string" ||
    typeof obj.appVersion !== "string" ||
    typeof obj.adaptiveStream !== "boolean" ||
    typeof obj.dynacast !== "boolean" ||
    typeof obj.platform !== "string"
  ) {
    return { ok: false, reason: "missing or wrong-typed required field" };
  }
  const userAgent = obj.userAgent;
  if (userAgent !== null && typeof userAgent !== "string" && typeof userAgent !== "undefined") {
    return { ok: false, reason: "userAgent must be string or null" };
  }
  return {
    ok: true,
    payload: {
      schemaVersion: 1,
      clientSdk: obj.clientSdk,
      clientSdkVersion: obj.clientSdkVersion,
      buildSha: obj.buildSha,
      appVersion: obj.appVersion,
      adaptiveStream: obj.adaptiveStream,
      dynacast: obj.dynacast,
      platform: obj.platform,
      userAgent: typeof userAgent === "string" ? userAgent : null,
    },
  };
}

/**
 * Handle a received agent_hello message.
 *
 * Logs a structured "agent_hello_received" line for every successful parse,
 * and an additional "client_misconfig_detected" line for known-bad
 * configurations (currently: adaptiveStream === true).
 *
 * Logging via `console.log` / `console.warn` to match the rest of this
 * codebase (no pino yet; project memory's mention is aspirational). The
 * structured-JSON-as-second-arg form is what tooling can grep.
 */
export function handleAgentHello(
  participantIdentity: string | undefined,
  rawPayload: Uint8Array
): void {
  const identity = participantIdentity ?? "<unknown>";
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(rawPayload));
  } catch (err) {
    console.warn("[AgentHello] Failed to decode payload from", identity, err);
    return;
  }

  const result = parseAgentHello(decoded);
  if (!result.ok) {
    console.warn(
      "[AgentHello] Rejected payload from",
      identity,
      JSON.stringify({ reason: result.reason, raw: decoded })
    );
    return;
  }

  const payload = result.payload;
  console.log(
    "[AgentHello]",
    JSON.stringify({
      event: "agent_hello_received",
      participant: identity,
      payload,
    })
  );

  if (payload.adaptiveStream === true) {
    console.warn(
      "[AgentHello]",
      JSON.stringify({
        event: "client_misconfig_detected",
        warning:
          "adaptiveStream=true breaks Tech World video/audio forwarding",
        participant: identity,
        clientSdkVersion: payload.clientSdkVersion,
        buildSha: payload.buildSha,
        appVersion: payload.appVersion,
      })
    );
  }
}
