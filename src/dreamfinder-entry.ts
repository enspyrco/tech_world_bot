/**
 * Dreamfinder's agent entry point — voice-interactive bot for Tech World.
 *
 * Unlike Clawd (text-only, data channels), DF uses audio tracks bridged
 * through OpenAI Realtime API. Players walk up and talk to DF; DF hears
 * them via LiveKit audio, responds via OpenAI, and publishes audio back.
 *
 * Data channels are still used for:
 *   - position: DF publishes its own, receives others' for proximity calc
 *   - map-info: receives map data from client
 *   - bot-mood: publishes mood state for client-side avatar expressions
 */

import type { JobContext } from "@livekit/agents";
import {
  RoomEvent,
  type RemoteParticipant,
  type RemoteAudioTrack,
  type RemoteTrackPublication,
  type TrackPublication,
  TrackKind,
} from "@livekit/rtc-node";
import {
  startWandering,
  type WorldState,
} from "./agent-loop.js";
import type { BotConfig } from "./bot-config.js";
import { OpenAIRealtimeSession } from "./openai-realtime.js";
import { DreamfinderAudioPipeline } from "./audio-pipeline.js";
import { TOOL_DEFINITIONS } from "./prompts/dreamfinder.js";

const DEFAULT_SPAWN = { x: 25, y: 25 };
const DEFAULT_GRID_SIZE = 50;
const DEFAULT_CELL_SIZE = 32;

/** Audio proximity threshold in grid squares (matches client-side). */
const AUDIO_RANGE = 2;

/** Publish bot's current position on the data channel. */
async function publishPosition(
  ctx: JobContext,
  world: WorldState,
  botConfig: BotConfig,
  cellSize: number = DEFAULT_CELL_SIZE,
): Promise<void> {
  const pixel = { x: world.position.x * cellSize, y: world.position.y * cellSize };
  const encoder = new TextEncoder();
  await ctx.room.localParticipant?.publishData(
    encoder.encode(JSON.stringify({
      playerId: botConfig.identity,
      points: [pixel],
      directions: ["none"],
    })),
    { topic: "position", reliable: false },
  );
}

/** Track other players' positions for proximity-based audio gating. */
const playerPositions = new Map<string, { x: number; y: number }>();

/**
 * Chebyshev distance — max of |dx|, |dy|. Matches the client's proximity
 * calculation which accounts for diagonal movement.
 */
function chebyshevDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Main entry function for Dreamfinder's LiveKit agent.
 * Called from index.ts when config.agentName === "dreamfinder".
 */
export async function dreamfinderEntry(
  ctx: JobContext,
  config: BotConfig,
): Promise<void> {
  console.log(`[DF] Connecting to room...`);
  await ctx.connect();
  const room = ctx.room;
  console.log(`[DF] Connected to room: ${room.name}`);

  const world: WorldState = {
    map: null,
    position: { ...DEFAULT_SPAWN },
  };

  // --- OpenAI Realtime session ---
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const session = new OpenAIRealtimeSession({
    apiKey,
    systemPrompt: config.systemPrompt,
    tools: TOOL_DEFINITIONS,
    voice: "ash",
    silenceDurationMs: 1200,
  });

  // --- Audio pipeline ---
  const pipeline = new DreamfinderAudioPipeline(session);

  // --- Connect OpenAI + publish audio track ---
  await session.connect();
  console.log("[DF] OpenAI Realtime connected");

  await pipeline.publishTrack(ctx.room.localParticipant!);
  console.log("[DF] Audio track published to room");

  // Start the input loop (mixer → resample → OpenAI) in background
  pipeline.startInputLoop().catch((err) =>
    console.error("[DF] Input loop error:", err),
  );

  // --- Tool call handling ---
  session.on("tool_call", async (name, argsJson, callId) => {
    console.log(`[DF] Tool call: ${name}`);
    try {
      // TODO: Wire up actual tool implementations (Phase 4)
      // For now, return a placeholder so the session doesn't hang.
      const result = JSON.stringify({
        status: "ok",
        message: `Tool ${name} not yet implemented in LiveKit agent`,
      });
      session.sendToolResult(callId, result);
    } catch (err) {
      session.sendToolResult(
        callId,
        JSON.stringify({ error: String(err) }),
      );
    }
  });

  // --- Mood extraction → data channel ---
  const encoder = new TextEncoder();
  session.on("transcript", (_text, mood) => {
    if (mood) {
      ctx.room.localParticipant
        ?.publishData(
          encoder.encode(JSON.stringify({ botId: config.identity, mood })),
          { topic: "bot-mood", reliable: false },
        )
        .catch(() => {}); // fire-and-forget
    }
  });

  // --- Position publishing + wandering ---
  await publishPosition(ctx, world, config);
  const wanderController = startWandering(ctx, world, config);

  // --- Data channel: receive map-info + player positions ---
  room.on(
    RoomEvent.DataReceived,
    (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (participant?.identity === config.identity) return;
      const decoder = new TextDecoder();

      if (topic === "map-info") {
        try {
          const msg = JSON.parse(decoder.decode(payload));
          world.map = {
            mapId: msg.mapId as string,
            barriers: msg.barriers as [number, number][],
            terminals: msg.terminals as [number, number][],
            spawnPoint: { x: msg.spawnPoint[0] as number, y: msg.spawnPoint[1] as number },
            gridSize: (msg.gridSize as number) || DEFAULT_GRID_SIZE,
            cellSize: (msg.cellSize as number) || DEFAULT_CELL_SIZE,
          };
          world.position = { ...world.map.spawnPoint };
          console.log(`[DF] Map: ${world.map.mapId} (${world.map.barriers.length} barriers)`);
          publishPosition(ctx, world, config, world.map.cellSize).catch(() => {});
        } catch (err) {
          console.error("[DF] map-info parse error:", err);
        }
        return;
      }

      // Track other players' positions for proximity audio gating
      if (topic === "position" && participant) {
        try {
          const msg = JSON.parse(decoder.decode(payload));
          const points = msg.points as { x: number; y: number }[];
          if (points?.length > 0) {
            const lastPoint = points[points.length - 1];
            playerPositions.set(participant.identity, lastPoint);
            updateProximityAudio(room, pipeline, world);
          }
        } catch {
          // Position messages are unreliable — silent drop is fine
        }
      }
    },
  );

  // --- Track subscription: auto-subscribe to audio tracks ---
  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteAudioTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (publication.kind !== TrackKind.KIND_AUDIO) return;
      if (participant.identity === config.identity) return;

      // Check if this participant is within audio range
      const pos = playerPositions.get(participant.identity);
      if (pos && chebyshevDistance(pos, world.position) <= AUDIO_RANGE) {
        pipeline.addParticipant(participant.identity, track);
      }
    },
  );

  // --- Participant lifecycle ---
  room.on(RoomEvent.ParticipantConnected, (participant) => {
    console.log(`[DF] Player joined: ${participant.identity}`);
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    console.log(`[DF] Player left: ${participant.identity}`);
    playerPositions.delete(participant.identity);
    pipeline.removeParticipant(participant.identity);
  });

  // --- Greeting ---
  // Wait a moment for the session to stabilise, then greet
  setTimeout(() => {
    session.sendText("You just appeared in a multiplayer game world. Give a brief, warm greeting to anyone nearby — one sentence max.");
  }, 2000);

  // --- Keep alive until disconnect ---
  console.log("[DF] Dreamfinder ready — listening for nearby players");

  await new Promise<void>((resolve) => {
    room.on(RoomEvent.Disconnected, () => {
      console.log("[DF] Room disconnected");
      wanderController.abort();
      session.close();
      pipeline.close().catch(() => {});
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Proximity audio management
// ---------------------------------------------------------------------------

/**
 * Check all tracked player positions against DF's position and
 * add/remove audio streams based on proximity threshold.
 */
function updateProximityAudio(
  room: { remoteParticipants: Map<string, RemoteParticipant> },
  pipeline: DreamfinderAudioPipeline,
  world: WorldState,
): void {
  for (const [identity, pos] of playerPositions) {
    const dist = chebyshevDistance(pos, world.position);
    const isActive = pipeline.activeParticipants.includes(identity);

    if (dist <= AUDIO_RANGE && !isActive) {
      // Player entered range — find their audio track and add to pipeline
      const participant = room.remoteParticipants.get(identity);
      if (!participant) continue;

      for (const pub of participant.trackPublications.values()) {
        if (pub.kind === TrackKind.KIND_AUDIO && pub.track) {
          pipeline.addParticipant(identity, pub.track as RemoteAudioTrack);
          break;
        }
      }
    } else if (dist > AUDIO_RANGE && isActive) {
      // Player left range — remove from pipeline
      pipeline.removeParticipant(identity);
    }
  }
}
