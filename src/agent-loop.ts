/**
 * Clawd's autonomous wandering behaviour.
 *
 * Picks random walkable destinations, pathfinds to them, publishes the full
 * path so the client can animate smooth movement, then pauses before repeating.
 *
 * The loop is cancellable via AbortController for Phase 4 (approach player).
 */

import type { JobContext } from "@livekit/agents";
import type { GridCell, DirectionName } from "./pathfinding.js";
import {
  findPath,
  buildBarrierSet,
  pathToDirections,
  pathToPixels,
} from "./pathfinding.js";

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
  /** Clawd's current position in mini-grid coordinates. */
  position: { x: number; y: number };
}

/** Movement timing — must match client's MoveToEffect duration. */
const STEP_DURATION_MS = 200;

/** Pause range between walks (milliseconds). */
const MIN_PAUSE_MS = 2_000;
const MAX_PAUSE_MS = 5_000;

/** Maximum path length to avoid very long walks. */
const MAX_PATH_LENGTH = 20;

/** Publish a full movement path on the `position` data channel. */
async function publishPath(
  ctx: JobContext,
  points: { x: number; y: number }[],
  directions: DirectionName[]
): Promise<void> {
  const payload = {
    playerId: "bot-claude",
    points,
    directions,
  };

  const encoder = new TextEncoder();
  await ctx.agent?.publishData(encoder.encode(JSON.stringify(payload)), {
    topic: "position",
    reliable: false,
  });
}

/** Pick a random walkable cell that isn't the current position. */
function pickRandomDestination(
  current: GridCell,
  barrierSet: Set<string>,
  gridSize: number
): GridCell | null {
  // Try up to 20 times to find a reachable destination
  for (let attempt = 0; attempt < 20; attempt++) {
    const x = Math.floor(Math.random() * gridSize);
    const y = Math.floor(Math.random() * gridSize);

    if (x === current.x && y === current.y) continue;
    if (barrierSet.has(`${x},${y}`)) continue;

    // Prefer destinations that aren't too far (keeps walks short and natural)
    const dist = Math.max(Math.abs(x - current.x), Math.abs(y - current.y));
    if (dist > MAX_PATH_LENGTH) continue;

    return { x, y };
  }
  return null;
}

/** Sleep that respects abort signal. Resolves false if aborted. */
function abortableSleep(
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
 * cancel wandering (e.g. to approach a stuck player in Phase 4).
 */
export function startWandering(
  ctx: JobContext,
  world: WorldState
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
      // Pick a random destination
      const dest = pickRandomDestination(
        world.position,
        barrierSet,
        map.gridSize
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
      const truncated = path.length > MAX_PATH_LENGTH
        ? path.slice(0, MAX_PATH_LENGTH + 1)
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
        await publishPath(ctx, points, directions);
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
        MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS);
      const pauseCompleted = await abortableSleep(pause, signal);
      if (!pauseCompleted) break;
    }

    console.log("[Wander] Wandering loop stopped");
  };

  loop().catch((err) => console.error("[Wander] Loop error:", err));

  return controller;
}
