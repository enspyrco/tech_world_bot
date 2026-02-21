/**
 * A* pathfinding on a 2D grid with 8-directional movement.
 *
 * Designed for the Tech World 50×50 grid. Barriers are stored as a Set of
 * "x,y" strings for O(1) lookup.
 */

/** A grid cell coordinate. */
export interface GridCell {
  x: number;
  y: number;
}

/** Direction names matching the Flutter client's Direction enum. */
export type DirectionName =
  | "up"
  | "upLeft"
  | "upRight"
  | "down"
  | "downLeft"
  | "downRight"
  | "left"
  | "right"
  | "none";

/** 8-directional neighbours with their direction names. */
const NEIGHBOURS: { dx: number; dy: number; name: DirectionName }[] = [
  { dx: 0, dy: -1, name: "up" },
  { dx: 0, dy: 1, name: "down" },
  { dx: -1, dy: 0, name: "left" },
  { dx: 1, dy: 0, name: "right" },
  { dx: -1, dy: -1, name: "upLeft" },
  { dx: 1, dy: -1, name: "upRight" },
  { dx: -1, dy: 1, name: "downLeft" },
  { dx: 1, dy: 1, name: "downRight" },
];

/** Cost: 1.0 for cardinal, ~1.41 for diagonal. */
const CARDINAL_COST = 1.0;
const DIAGONAL_COST = 1.414;

/** Build a barrier lookup set from [x, y] pairs. */
export function buildBarrierSet(barriers: [number, number][]): Set<string> {
  const set = new Set<string>();
  for (const [x, y] of barriers) {
    set.add(`${x},${y}`);
  }
  return set;
}

/**
 * Find the shortest path from `start` to `goal` using A* with 8-directional
 * movement. Returns the path as a list of grid cells (including start and
 * goal), or an empty array if no path exists.
 */
export function findPath(
  start: GridCell,
  goal: GridCell,
  barrierSet: Set<string>,
  gridSize: number = 50
): GridCell[] {
  const key = (c: GridCell) => `${c.x},${c.y}`;
  const startKey = key(start);
  const goalKey = key(goal);

  if (startKey === goalKey) return [start];
  if (barrierSet.has(goalKey)) return [];

  // Chebyshev distance heuristic (consistent with 8-directional movement)
  const h = (c: GridCell) => Math.max(Math.abs(c.x - goal.x), Math.abs(c.y - goal.y));

  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();
  const cameFrom = new Map<string, string>();

  gScore.set(startKey, 0);
  fScore.set(startKey, h(start));

  // Simple open set using an array (fast enough for 50×50)
  const openSet = new Set<string>([startKey]);
  const allCells = new Map<string, GridCell>();
  allCells.set(startKey, start);
  allCells.set(goalKey, goal);

  while (openSet.size > 0) {
    // Find node in openSet with lowest fScore
    let currentKey = "";
    let lowestF = Infinity;
    for (const k of openSet) {
      const f = fScore.get(k) ?? Infinity;
      if (f < lowestF) {
        lowestF = f;
        currentKey = k;
      }
    }

    if (currentKey === goalKey) {
      // Reconstruct path
      const path: GridCell[] = [];
      let traceKey = goalKey;
      while (traceKey !== undefined) {
        path.push(allCells.get(traceKey)!);
        traceKey = cameFrom.get(traceKey)!;
      }
      path.reverse();
      return path;
    }

    openSet.delete(currentKey);
    const current = allCells.get(currentKey)!;
    const currentG = gScore.get(currentKey)!;

    for (const { dx, dy } of NEIGHBOURS) {
      const nx = current.x + dx;
      const ny = current.y + dy;

      // Bounds check
      if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;

      const nKey = `${nx},${ny}`;
      if (barrierSet.has(nKey)) continue;

      // For diagonal movement, ensure both adjacent cardinal cells are clear
      // (prevents cutting corners through barriers)
      if (dx !== 0 && dy !== 0) {
        if (
          barrierSet.has(`${current.x + dx},${current.y}`) ||
          barrierSet.has(`${current.x},${current.y + dy}`)
        ) {
          continue;
        }
      }

      const moveCost = dx !== 0 && dy !== 0 ? DIAGONAL_COST : CARDINAL_COST;
      const tentativeG = currentG + moveCost;

      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        const neighbour: GridCell = { x: nx, y: ny };
        allCells.set(nKey, neighbour);
        cameFrom.set(nKey, currentKey);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + h(neighbour));
        openSet.add(nKey);
      }
    }
  }

  // No path found
  return [];
}

/**
 * Compute the direction name for each step along a path of grid cells.
 * Returns one fewer direction than path length (first cell has no direction).
 */
export function pathToDirections(path: GridCell[]): DirectionName[] {
  const directions: DirectionName[] = [];
  for (let i = 1; i < path.length; i++) {
    const dx = Math.sign(path[i].x - path[i - 1].x);
    const dy = Math.sign(path[i].y - path[i - 1].y);
    const match = NEIGHBOURS.find((n) => n.dx === dx && n.dy === dy);
    directions.push(match?.name ?? "none");
  }
  return directions;
}

/**
 * Convert a path of grid cells to pixel positions.
 */
export function pathToPixels(
  path: GridCell[],
  cellSize: number
): { x: number; y: number }[] {
  return path.map((c) => ({ x: c.x * cellSize, y: c.y * cellSize }));
}
