import { Direction, Point, Pose, Spot, SpotKind, SPOTS, findPath, directionBetween, neighboursOf } from './officeMap';

/**
 * Where each agent physically is and what it is doing there. The LLM decides *what* to do
 * (work, talk, idle, a task workflow phase); this turns that into walking to the right place
 * and a pose the UI can animate: typing at the desk, presenting at the whiteboard, coffee breaks, ...
 */

export type Activity = 'walk' | 'type' | 'read' | 'sit' | 'stand' | 'talk' | 'present' | 'drink' | 'snack' | 'lounge';
export type WorkPhase = 'plan' | 'research' | 'execute' | 'review' | 'finalize';

/** The fields of AgentState this controller reads and writes. */
export interface Body {
    x: number;
    y: number;
    direction: string;
    activity: string;
    pose: string;
    energy: number;
    deskX: number;
    deskY: number;
}

export interface LifeInput {
    /** The agent's last LLM action: work | talk | idle | use_tool. */
    action: string;
    /** Agent id being talked to. */
    talkTo?: string;
    /** Current phase of the agent's task workflow, if one is running. */
    phase?: WorkPhase | '';
    /** Teammate reviewing the agent's work during the review phase. */
    reviewerId?: string;
    lastTool?: string;
    /** The user is waiting for an answer: skip or cut short a break. */
    urgent?: boolean;
}

interface BodyMap {
    get(id: string): Body | undefined;
    forEach(callback: (body: Body, id: string) => void): void;
}

/** Server movement tick; the UI tweens each step over the same duration. */
export const STEP_MS = 300;
export const BREAK_THRESHOLD = 0.25;
const COFFEE_MS = 8000;
const MAX_REST_MS = 30000;
const READING_TOOLS = ['web_search', 'read_file'];

const DRAIN_PER_SEC: Partial<Record<Activity, number>> = {
    type: 1 / 300, read: 1 / 300, present: 1 / 240, talk: 1 / 400, walk: 1 / 600, sit: 1 / 900, stand: 1 / 900
};
const RECOVER_PER_SEC: Partial<Record<Activity, number>> = { drink: 1 / 40, snack: 1 / 30, lounge: 1 / 30 };

const SPOT_ACTIVITY: Record<SpotKind, Activity> = {
    desk: 'type', meeting: 'sit', whiteboard: 'present', standing_desk: 'read', lounge: 'lounge',
    coffee: 'drink', water: 'drink', snack: 'snack', bookshelf: 'read', printer: 'stand'
};

interface Goal {
    key: string;
    target: Point;
    activity: Activity;
    pose: Pose;
    dir?: Direction;
    /** Face this point on arrival (used when standing next to someone). */
    face?: Point;
}

interface Mind {
    path: Point[];
    pathKey: string;
    /** A shared spot (not the agent's own desk) this agent has claimed. */
    spot: Spot | null;
    breakStage: 'coffee' | 'rest' | null;
    stageUntil: number;
    idlePlan: 'desk' | 'lounge' | 'pantry' | null;
}

const at = (body: Point, p: Point) => body.x === p.x && body.y === p.y;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class OfficeLife {
    private minds = new Map<string, Mind>();
    /** spot id -> agent id */
    private claims = new Map<string, string>();

    constructor(private rng: () => number = Math.random) {}

    add(id: string, body: Body) {
        this.minds.set(id, { path: [], pathKey: '', spot: null, breakStage: null, stageUntil: 0, idlePlan: null });
        // Start everyone at a different energy level so breaks are staggered.
        body.energy = 0.55 + this.rng() * 0.45;
        body.activity = 'stand';
        body.pose = 'stand';
    }

    remove(id: string) {
        const mind = this.minds.get(id);
        if (mind) this.release(id, mind);
        this.minds.delete(id);
    }

    isOnBreak(id: string): boolean {
        return Boolean(this.minds.get(id)?.breakStage);
    }

    step(bodies: BodyMap, inputs: (id: string) => LifeInput, now = Date.now(), dtMs = STEP_MS) {
        bodies.forEach((body, id) => {
            const mind = this.minds.get(id);
            if (!mind) return;
            const input = inputs(id);
            if (input.action !== 'idle') mind.idlePlan = null;
            this.updateBreak(id, body, mind, input, now);
            const goal = this.chooseGoal(id, body, mind, input, bodies);
            this.moveToward(body, mind, goal);
            this.updateEnergy(body, dtMs);
        });
    }

    // ─── BREAKS ───

    private updateBreak(id: string, body: Body, mind: Mind, input: LifeInput, now: number) {
        if (!mind.breakStage) {
            const busy = input.urgent || input.action === 'talk' || input.phase === 'review' || input.phase === 'plan';
            if (body.energy < BREAK_THRESHOLD && !busy && this.claim(id, body, mind, ['coffee', 'water'])) {
                mind.breakStage = 'coffee';
                mind.stageUntil = 0;
            }
            return;
        }
        if (input.urgent || !mind.spot) {
            this.endBreak(id, mind);
            return;
        }
        if (!at(body, mind.spot)) return;
        // The stage timer starts once the agent has arrived.
        if (mind.stageUntil === 0) {
            mind.stageUntil = now + (mind.breakStage === 'coffee' ? COFFEE_MS : MAX_REST_MS);
            return;
        }
        if (mind.breakStage === 'coffee' && now >= mind.stageUntil) {
            if (this.claim(id, body, mind, this.rng() < 0.6 ? ['snack', 'lounge'] : ['lounge', 'snack'])) {
                mind.breakStage = 'rest';
                mind.stageUntil = 0;
            } else if (body.energy > 0.6) {
                this.endBreak(id, mind);
            } else {
                mind.stageUntil = now + COFFEE_MS; // every seat is taken: have another cup
            }
        } else if (mind.breakStage === 'rest' && (body.energy >= 0.98 || now >= mind.stageUntil)) {
            this.endBreak(id, mind);
        }
    }

    private endBreak(id: string, mind: Mind) {
        mind.breakStage = null;
        mind.stageUntil = 0;
        this.release(id, mind);
    }

    // ─── GOALS ───

    private chooseGoal(id: string, body: Body, mind: Mind, input: LifeInput, bodies: BodyMap): Goal {
        if (mind.breakStage && mind.spot) return this.spotGoal(mind.spot);

        switch (input.phase) {
            case 'plan':
                return this.sharedSpotGoal(id, body, mind, ['whiteboard']) || this.deskGoal(id, mind, body, 'type');
            case 'research':
                return this.sharedSpotGoal(id, body, mind, ['bookshelf']) || this.deskGoal(id, mind, body, 'read');
            case 'execute':
                return this.deskGoal(id, mind, body, 'type');
            case 'review': {
                const reviewer = input.reviewerId ? bodies.get(input.reviewerId) : undefined;
                if (reviewer) return this.besideGoal(id, mind, body, reviewer, bodies);
                return this.sharedSpotGoal(id, body, mind, ['standing_desk']) || this.deskGoal(id, mind, body, 'read');
            }
            case 'finalize':
                return this.sharedSpotGoal(id, body, mind, ['printer']) || this.deskGoal(id, mind, body, 'type');
        }

        if (input.action === 'talk') {
            const partner = input.talkTo ? bodies.get(input.talkTo) : undefined;
            // Talking to a teammate means walking over; answering the user or the whole team is typed at the desk.
            return partner ? this.besideGoal(id, mind, body, partner, bodies) : this.deskGoal(id, mind, body, 'type');
        }
        if (input.action === 'use_tool') {
            return this.deskGoal(id, mind, body, READING_TOOLS.includes(input.lastTool || '') ? 'read' : 'type');
        }
        if (input.action === 'work') return this.deskGoal(id, mind, body, 'type');

        // Idle: pick once per idle stretch between relaxing at the desk, the bean bags or the pantry.
        if (!mind.idlePlan) {
            const roll = this.rng();
            mind.idlePlan = roll < 0.5 ? 'desk' : roll < 0.75 ? 'lounge' : 'pantry';
        }
        if (mind.idlePlan === 'lounge') {
            const goal = this.sharedSpotGoal(id, body, mind, ['lounge']);
            if (goal) return goal;
        } else if (mind.idlePlan === 'pantry') {
            const goal = this.sharedSpotGoal(id, body, mind, ['water', 'coffee']);
            if (goal) return goal;
        }
        return this.deskGoal(id, mind, body, 'sit');
    }

    private spotGoal(spot: Spot): Goal {
        return { key: spot.id, target: spot, activity: SPOT_ACTIVITY[spot.kind], pose: spot.pose, dir: spot.dir };
    }

    private sharedSpotGoal(id: string, body: Body, mind: Mind, kinds: SpotKind[]): Goal | null {
        const spot = this.claim(id, body, mind, kinds);
        return spot ? this.spotGoal(spot) : null;
    }

    private deskGoal(id: string, mind: Mind, body: Body, activity: Activity): Goal {
        this.release(id, mind);
        return { key: 'desk', target: { x: body.deskX, y: body.deskY }, activity, pose: 'sit', dir: 'up' };
    }

    /** Stand on a free tile next to another agent and face them. */
    private besideGoal(id: string, mind: Mind, body: Body, other: Body, bodies: BodyMap): Goal {
        this.release(id, mind);
        const goal: Goal = { key: 'beside', target: body, activity: 'talk', pose: 'stand', face: other };
        if (Math.abs(body.x - other.x) + Math.abs(body.y - other.y) === 1) return goal;
        const taken = new Set<string>();
        bodies.forEach((b, otherId) => { if (otherId !== id) taken.add(`${b.x},${b.y}`); });
        const free = neighboursOf(other, body).find(p => !taken.has(`${p.x},${p.y}`));
        if (free) goal.target = free;
        return goal;
    }

    // ─── SPOT CLAIMS ───

    /** Keeps the agent's current spot if it is one of `kinds`, else claims the nearest free one. */
    private claim(id: string, body: Body, mind: Mind, kinds: SpotKind[]): Spot | null {
        if (mind.spot && kinds.includes(mind.spot.kind)) return mind.spot;
        const free = SPOTS
            .filter(s => kinds.includes(s.kind) && !this.claims.has(s.id))
            .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
                (Math.abs(a.x - body.x) + Math.abs(a.y - body.y)) - (Math.abs(b.x - body.x) + Math.abs(b.y - body.y)));
        if (free.length === 0) return null;
        this.release(id, mind);
        mind.spot = free[0];
        this.claims.set(free[0].id, id);
        return free[0];
    }

    private release(id: string, mind: Mind) {
        if (mind.spot && this.claims.get(mind.spot.id) === id) this.claims.delete(mind.spot.id);
        mind.spot = null;
    }

    // ─── MOVEMENT ───

    private moveToward(body: Body, mind: Mind, goal: Goal) {
        if (at(body, goal.target)) {
            mind.path = [];
            body.activity = goal.activity;
            body.pose = goal.pose;
            const facing = goal.face ? directionBetween(body, goal.face) : goal.dir;
            if (facing) body.direction = facing;
            return;
        }
        const pathKey = `${goal.key}@${goal.target.x},${goal.target.y}`;
        if (mind.pathKey !== pathKey || mind.path.length === 0) {
            mind.path = findPath(body, goal.target);
            mind.pathKey = pathKey;
        }
        const next = mind.path.shift();
        if (!next) {
            // Unreachable target: wait where we are.
            body.activity = 'stand';
            body.pose = 'stand';
            return;
        }
        body.direction = directionBetween(body, next);
        body.x = next.x;
        body.y = next.y;
        body.activity = 'walk';
        body.pose = 'stand';
    }

    private updateEnergy(body: Body, dtMs: number) {
        const activity = body.activity as Activity;
        const seconds = dtMs / 1000;
        body.energy = clamp01(body.energy - (DRAIN_PER_SEC[activity] || 0) * seconds + (RECOVER_PER_SEC[activity] || 0) * seconds);
    }
}
