import { DESK_SEATS } from './agents';

/**
 * Walkable layout of the office in tiles (16px each), matching what packages/ui/src/game/Game.ts draws.
 * Walls and furniture block movement; "spots" are the places agents go to sit or stand
 * (desk chairs, meeting chairs, the coffee machine, bean bags, ...).
 */

export const MAP_SIZE = 40;
const MIN_TILE = 1;
const MAX_TILE = MAP_SIZE - 2;

export type Direction = 'up' | 'down' | 'left' | 'right';
export type Pose = 'sit' | 'stand';
export type SpotKind =
    | 'desk' | 'meeting' | 'whiteboard' | 'standing_desk' | 'lounge'
    | 'coffee' | 'water' | 'snack' | 'bookshelf' | 'printer';

export interface Point {
    x: number;
    y: number;
}

export interface Spot extends Point {
    id: string;
    kind: SpotKind;
    dir: Direction;
    pose: Pose;
}

/** Where hired agents walk in: the top of the hallway between the meeting room and the collab area. */
export const ENTRANCE: Point = { x: 16, y: 2 };

const blocked = new Set<string>();
const key = (x: number, y: number) => `${x},${y}`;

function block(x1: number, y1: number, x2: number, y2: number, except: Point[] = []) {
    for (let x = x1; x <= x2; x++) {
        for (let y = y1; y <= y2; y++) {
            if (!except.some(p => p.x === x && p.y === y)) blocked.add(key(x, y));
        }
    }
}

/** Walls of a rectangular room, leaving the given door tiles open. */
function room(x1: number, y1: number, x2: number, y2: number, doors: Point[]) {
    block(x1, y1, x2, y1, doors);
    block(x1, y2, x2, y2, doors);
    block(x1, y1, x1, y2, doors);
    block(x2, y1, x2, y2, doors);
}

// Rooms
room(2, 2, 15, 12, [{ x: 12, y: 12 }, { x: 13, y: 12 }, { x: 14, y: 12 }]);   // meeting room
room(17, 2, 30, 12, [{ x: 18, y: 12 }, { x: 19, y: 12 }]);                     // collab area
room(22, 22, 33, 33, [{ x: 22, y: 26 }, { x: 22, y: 27 }]);                    // coffee & pantry

// Furniture
block(5, 5, 11, 8);     // meeting table
block(3, 3, 6, 3);      // whiteboard
block(19, 4, 21, 5);    // standing desk 1
block(26, 4, 28, 5);    // standing desk 2
block(23, 23, 28, 24);  // pantry counter, coffee machine, microwave
block(29, 24, 30, 26);  // water cooler
block(24, 28, 26, 29);  // snack table
block(34, 3, 36, 8);    // bookshelf
block(34, 9, 35, 9);    // printer
for (const [px, py] of [[1, 13], [2, 13], [9, 13], [1, 31], [2, 31], [34, 12], [38, 18], [38, 19]]) {
    block(px, py, px, py); // potted plants
}
// Work desks sit above each chair: 4 tiles wide, 2 tall.
for (const seat of DESK_SEATS) block(seat.x - 1, seat.y - 2, seat.x + 2, seat.y - 1);

function spot(id: string, kind: SpotKind, x: number, y: number, dir: Direction, pose: Pose): Spot {
    return { id, kind, x, y, dir, pose };
}

export const SPOTS: Spot[] = [
    ...DESK_SEATS.map((s, i) => spot(`desk_${i}`, 'desk', s.x, s.y, 'up', 'sit')),
    spot('meeting_t1', 'meeting', 6, 4, 'down', 'sit'),
    spot('meeting_t2', 'meeting', 8, 4, 'down', 'sit'),
    spot('meeting_t3', 'meeting', 10, 4, 'down', 'sit'),
    spot('meeting_b1', 'meeting', 6, 9, 'up', 'sit'),
    spot('meeting_b2', 'meeting', 8, 9, 'up', 'sit'),
    spot('meeting_b3', 'meeting', 10, 9, 'up', 'sit'),
    spot('meeting_l1', 'meeting', 4, 6, 'right', 'sit'),
    spot('meeting_l2', 'meeting', 4, 8, 'right', 'sit'),
    spot('meeting_r1', 'meeting', 12, 6, 'left', 'sit'),
    spot('meeting_r2', 'meeting', 12, 8, 'left', 'sit'),
    spot('whiteboard_1', 'whiteboard', 3, 4, 'up', 'stand'),
    spot('whiteboard_2', 'whiteboard', 4, 4, 'up', 'stand'),
    spot('standing_1', 'standing_desk', 19, 6, 'up', 'stand'),
    spot('standing_2', 'standing_desk', 21, 6, 'up', 'stand'),
    spot('standing_3', 'standing_desk', 26, 6, 'up', 'stand'),
    spot('standing_4', 'standing_desk', 28, 6, 'up', 'stand'),
    spot('lounge_1', 'lounge', 20, 9, 'down', 'sit'),
    spot('lounge_2', 'lounge', 23, 10, 'down', 'sit'),
    spot('lounge_3', 'lounge', 27, 9, 'down', 'sit'),
    spot('coffee_1', 'coffee', 24, 25, 'up', 'stand'),
    spot('coffee_2', 'coffee', 26, 25, 'up', 'stand'),
    spot('water_1', 'water', 28, 26, 'right', 'stand'),
    spot('snack_1', 'snack', 23, 28, 'right', 'sit'),
    spot('snack_2', 'snack', 23, 29, 'right', 'sit'),
    spot('snack_3', 'snack', 27, 28, 'left', 'sit'),
    spot('snack_4', 'snack', 27, 29, 'left', 'sit'),
    spot('bookshelf_1', 'bookshelf', 33, 6, 'right', 'stand'),
    spot('printer_1', 'printer', 34, 10, 'up', 'stand')
];

const spotTiles = new Set(SPOTS.map(s => key(s.x, s.y)));

export function inBounds(x: number, y: number): boolean {
    return x >= MIN_TILE && x <= MAX_TILE && y >= MIN_TILE && y <= MAX_TILE;
}

/** Walls and furniture. */
export function isBlocked(x: number, y: number): boolean {
    return !inBounds(x, y) || blocked.has(key(x, y));
}

/** Free floor. Spots are only entered as the end of a path, so agents walk around other people's chairs. */
export function isWalkable(x: number, y: number): boolean {
    return !isBlocked(x, y) && !spotTiles.has(key(x, y));
}

const STEPS: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * Shortest 4-directional path. The result starts with the first step and ends on the goal;
 * it is empty when already there or when the goal cannot be reached.
 */
export function findPath(start: Point, goal: Point): Point[] {
    if (start.x === goal.x && start.y === goal.y) return [];
    if (isBlocked(goal.x, goal.y)) return [];
    const startKey = key(start.x, start.y);
    const goalKey = key(goal.x, goal.y);
    const cameFrom = new Map<string, string>([[startKey, '']]);
    const queue: Point[] = [start];
    for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        for (const [dx, dy] of STEPS) {
            const nx = current.x + dx;
            const ny = current.y + dy;
            const nextKey = key(nx, ny);
            if (cameFrom.has(nextKey)) continue;
            if (nextKey !== goalKey && !isWalkable(nx, ny)) continue;
            cameFrom.set(nextKey, key(current.x, current.y));
            if (nextKey === goalKey) return rebuild(cameFrom, goalKey);
            queue.push({ x: nx, y: ny });
        }
    }
    return [];
}

function rebuild(cameFrom: Map<string, string>, goalKey: string): Point[] {
    const path: Point[] = [];
    for (let at = goalKey; cameFrom.get(at); at = cameFrom.get(at)!) {
        const [x, y] = at.split(',').map(Number);
        path.unshift({ x, y });
    }
    return path;
}

export function directionBetween(from: Point, to: Point): Direction {
    if (to.x > from.x) return 'right';
    if (to.x < from.x) return 'left';
    return to.y < from.y ? 'up' : 'down';
}

/** Free floor tiles next to a point, nearest to `from` first. */
export function neighboursOf(target: Point, from: Point): Point[] {
    return STEPS
        .map(([dx, dy]) => ({ x: target.x + dx, y: target.y + dy }))
        .filter(p => isWalkable(p.x, p.y))
        .sort((a, b) => (Math.abs(a.x - from.x) + Math.abs(a.y - from.y)) - (Math.abs(b.x - from.x) + Math.abs(b.y - from.y)));
}
