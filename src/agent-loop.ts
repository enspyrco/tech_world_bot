/**
 * Autonomous wandering behaviour for bot characters.
 *
 * Picks random walkable destinations, pathfinds to them, publishes the full
 * path so the client can animate smooth movement, then pauses before repeating.
 *
 * The loop is cancellable via AbortController (e.g. to approach a stuck player).
 */

import type { JobContext } from "@livekit/agents";
import type { GridCell, DirectionName } from "./pathfinding.js";
import {
  findPath,
  buildBarrierSet,
  pathToDirections,
  pathToPixels,
} from "./pathfinding.js";
import type { BotConfig } from "./bot-config.js";

/** Tracks a player who currently has a terminal editor open. */
export interface PlayerTerminalState {
  playerId: string;
  playerName: string;
  challengeId: string;
  challengeTitle: string;
  challengeDescription: string;
  terminalX: number;
  terminalY: number;
  /** Timestamp (Date.now()) when the editor was opened. */
  openedAt: number;
  /** Whether a proactive nudge has already been offered this session. */
  proactiveOffered: boolean;
  /** Whether an explicit help-request was received for this session. */
  helpRequestActive: boolean;
}

/**
 * Dreamfinder's square, in mini-grid cells (inclusive bounds).
 *
 * Resolved on the client and shipped verbatim over `map-info`, so the bot's
 * wander bound and audio gate read the same box the client draws — the drawn
 * zone, the walk, and who DF hears can never drift apart.
 */
export interface TerritoryRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Whether cell (x, y) lies inside the territory (inclusive). */
export function cellInTerritory(
  x: number,
  y: number,
  rect: TerritoryRect,
): boolean {
  return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
}

/** Parse the wire form `[minX, minY, maxX, maxY]` from map-info. */
export function parseTerritory(wire: unknown): TerritoryRect | null {
  if (!Array.isArray(wire) || wire.length !== 4) return null;
  const [minX, minY, maxX, maxY] = wire.map((n) => Math.round(Number(n)));
  if ([minX, minY, maxX, maxY].some((n) => Number.isNaN(n))) return null;
  return { minX, minY, maxX, maxY };
}

/** Centre cell (integer-floored) of a territory rect. */
export function territoryCenter(rect: TerritoryRect): GridCell {
  return {
    x: (rect.minX + rect.maxX) >> 1,
    y: (rect.minY + rect.maxY) >> 1,
  };
}

/**
 * Nearest non-barrier cell to `center`, searched in expanding Chebyshev rings
 * and clamped to the grid. Mirrors the client's spawn snap so bot and client
 * seat Dreamfinder on the same cell.
 */
export function nearestWalkableCell(
  center: GridCell,
  barrierSet: Set<string>,
  gridSize: number,
): GridCell {
  const free = (x: number, y: number) =>
    x >= 0 && x < gridSize && y >= 0 && y < gridSize &&
    !barrierSet.has(`${x},${y}`);
  if (free(center.x, center.y)) return { x: center.x, y: center.y };
  for (let r = 1; r < gridSize; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (free(center.x + dx, center.y + dy)) {
          return { x: center.x + dx, y: center.y + dy };
        }
      }
    }
  }
  return { x: center.x, y: center.y };
}

/** Mutable world state — shared with index.ts. */
export interface WorldState {
  map: {
    mapId: string;
    barriers: [number, number][];
    terminals: [number, number][];
    spawnPoint: { x: number; y: number };
    gridSize: number;
    cellSize: number;
  } | null;
  /** Bot's current position in mini-grid coordinates. */
  position: { x: number; y: number };
  /**
   * Dreamfinder's square. When set, the wander loop keeps DF inside it. Absent
   * for other bots (Clawd), which roam the whole map.
   */
  territory?: TerritoryRect | null;
}

/** Movement timing — must match client's MoveToEffect duration. */
export const STEP_DURATION_MS = 200;

/** Publish a full movement path on the `position` data channel. */
export async function publishPath(
  ctx: JobContext,
  points: { x: number; y: number }[],
  directions: DirectionName[],
  botConfig: BotConfig
): Promise<void> {
  const payload = {
    playerId: botConfig.identity,
    points,
    directions,
  };

  const encoder = new TextEncoder();
  await ctx.agent?.publishData(encoder.encode(JSON.stringify(payload)), {
    topic: "position",
    reliable: false,
  });
}

/**
 * Pick a random walkable cell that isn't the current position.
 *
 * When [territory] is set, destinations are drawn from inside the square only,
 * so Dreamfinder drifts around his zone instead of roaming the whole map. When
 * null (other bots), the whole grid is fair game.
 */
function pickRandomDestination(
  current: GridCell,
  barrierSet: Set<string>,
  gridSize: number,
  maxPathLength: number,
  territory?: TerritoryRect | null
): GridCell | null {
  // Try up to 20 times to find a reachable destination
  for (let attempt = 0; attempt < 20; attempt++) {
    const x = territory
      ? territory.minX +
        Math.floor(Math.random() * (territory.maxX - territory.minX + 1))
      : Math.floor(Math.random() * gridSize);
    const y = territory
      ? territory.minY +
        Math.floor(Math.random() * (territory.maxY - territory.minY + 1))
      : Math.floor(Math.random() * gridSize);

    if (x === current.x && y === current.y) continue;
    if (barrierSet.has(`${x},${y}`)) continue;

    // Prefer destinations that aren't too far (keeps walks short and natural)
    const dist = Math.max(Math.abs(x - current.x), Math.abs(y - current.y));
    if (dist > maxPathLength) continue;

    return { x, y };
  }
  return null;
}

/** Sleep that respects abort signal. Resolves false if aborted. */
export function abortableSleep(
  ms: number,
  signal: AbortSignal
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(true), ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Start the wandering loop. Returns the AbortController so callers can
 * cancel wandering (e.g. to approach a stuck player).
 */
export function startWandering(
  ctx: JobContext,
  world: WorldState,
  botConfig: BotConfig
): AbortController {
  const controller = new AbortController();
  const { signal } = controller;

  const loop = async () => {
    console.log("[Wander] Wandering loop started — waiting for map-info...");

    // Wait until we have map data
    while (!world.map && !signal.aborted) {
      await abortableSleep(1_000, signal);
    }

    if (signal.aborted) return;

    const map = world.map!;
    const barrierSet = buildBarrierSet(map.barriers);

    console.log(
      `[Wander] Map loaded: ${map.mapId}. Starting to wander ` +
        `(${map.barriers.length} barriers, grid ${map.gridSize}×${map.gridSize})`
    );

    while (!signal.aborted) {
      const { minPauseMs, maxPauseMs, maxPathLength } = botConfig.wanderConfig;

      // Pick a random destination (bounded to DF's square when one is set).
      // Read territory fresh each iteration — it may arrive with map-info after
      // the loop has already started.
      const dest = pickRandomDestination(
        world.position,
        barrierSet,
        map.gridSize,
        maxPathLength,
        world.territory
      );

      if (!dest) {
        // Couldn't find a good destination — wait and try again
        await abortableSleep(2_000, signal);
        continue;
      }

      // Pathfind
      const path = findPath(world.position, dest, barrierSet, map.gridSize);

      if (path.length < 2) {
        // No path or already at destination
        await abortableSleep(1_000, signal);
        continue;
      }

      // Truncate long paths
      const truncated = path.length > maxPathLength
        ? path.slice(0, maxPathLength + 1)
        : path;

      const directions = pathToDirections(truncated);
      const points = pathToPixels(truncated, map.cellSize);

      console.log(
        `[Wander] Walking from (${world.position.x},${world.position.y}) → ` +
          `(${truncated[truncated.length - 1].x},${truncated[truncated.length - 1].y}) ` +
          `(${directions.length} steps)`
      );

      // Publish the full path for the client to animate
      try {
        await publishPath(ctx, points, directions, botConfig);
      } catch (err) {
        console.error("[Wander] Failed to publish path:", err);
        await abortableSleep(2_000, signal);
        continue;
      }

      // Wait for the movement to complete on the client
      const moveDuration = directions.length * STEP_DURATION_MS;
      const completed = await abortableSleep(moveDuration, signal);
      if (!completed) break;

      // Update our position to the end of the path
      const end = truncated[truncated.length - 1];
      world.position = { x: end.x, y: end.y };

      // Pause between walks (randomized for natural feel)
      const pause =
        minPauseMs + Math.random() * (maxPauseMs - minPauseMs);
      const pauseCompleted = await abortableSleep(pause, signal);
      if (!pauseCompleted) break;
    }

    console.log("[Wander] Wandering loop stopped");
  };

  loop().catch((err) => console.error("[Wander] Loop error:", err));

  return controller;
}

/**
 * Find a walkable cell adjacent to a terminal position.
 *
 * Terminals themselves may be barriers, so this looks at all 8 neighbours
 * and returns the nearest walkable one (preferring cardinal directions).
 * Returns `null` if no adjacent cell is walkable.
 */
export function findAdjacentCell(
  terminal: GridCell,
  barrierSet: Set<string>,
  gridSize: number
): GridCell | null {
  // Cardinal directions first (more natural approach angles), then diagonals
  const offsets = [
    { dx: 0, dy: 1 },   // below
    { dx: 0, dy: -1 },  // above
    { dx: -1, dy: 0 },  // left
    { dx: 1, dy: 0 },   // right
    { dx: -1, dy: 1 },  // below-left
    { dx: 1, dy: 1 },   // below-right
    { dx: -1, dy: -1 }, // above-left
    { dx: 1, dy: -1 },  // above-right
  ];

  for (const { dx, dy } of offsets) {
    const x = terminal.x + dx;
    const y = terminal.y + dy;
    if (x < 0 || x >= gridSize || y < 0 || y >= gridSize) continue;
    if (barrierSet.has(`${x},${y}`)) continue;
    return { x, y };
  }
  return null;
}

/** Default time a player must be at a terminal before the bot proactively offers help. */
const DEFAULT_STUCK_THRESHOLD_MS = 120_000; // 2 minutes

/** Default interval between stuck-detection checks. */
const DEFAULT_CHECK_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Periodically check for players who have been at a terminal for a while
 * without requesting help, and notify the callback with the longest-waiting
 * candidate.
 *
 * Returns an AbortController so the caller can stop the loop.
 */
export function startStuckDetection(
  trackedPlayers: Map<string, PlayerTerminalState>,
  onStuckPlayerFound: (player: PlayerTerminalState) => Promise<void>,
  stuckThresholdMs: number = DEFAULT_STUCK_THRESHOLD_MS,
  checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): AbortController {
  const controller = new AbortController();
  const { signal } = controller;

  const loop = async () => {
    console.log("[StuckDetect] Detection loop started");

    while (!signal.aborted) {
      const ok = await abortableSleep(checkIntervalMs, signal);
      if (!ok) break;

      // Find candidates: open long enough, no proactive offer yet, no help request
      const now = Date.now();
      let oldest: PlayerTerminalState | null = null;

      for (const player of trackedPlayers.values()) {
        const elapsed = now - player.openedAt;
        if (
          elapsed >= stuckThresholdMs &&
          !player.proactiveOffered &&
          !player.helpRequestActive
        ) {
          if (!oldest || player.openedAt < oldest.openedAt) {
            oldest = player;
          }
        }
      }

      if (oldest) {
        console.log(
          `[StuckDetect] Player "${oldest.playerName}" stuck on ` +
            `"${oldest.challengeTitle}" for ${Math.round((now - oldest.openedAt) / 1000)}s ` +
            `(${trackedPlayers.size} tracked)`
        );
        try {
          await onStuckPlayerFound(oldest);
        } catch (err) {
          console.error("[StuckDetect] Error handling stuck player:", err);
        }
      }
    }

    console.log("[StuckDetect] Detection loop stopped");
  };

  loop().catch((err) => console.error("[StuckDetect] Loop error:", err));

  return controller;
}
