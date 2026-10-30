import { SPOTS, ENTRANCE, findPath, isBlocked, isWalkable } from '../officeMap';
import { OfficeLife, Body, LifeInput, BREAK_THRESHOLD, STEP_MS } from '../behavior';
import { Semaphore } from '../limiter';
import { DESK_SEATS } from '../agents';

describe('office map', () => {
    it('lets every spot be reached from the entrance and from every desk', () => {
        for (const spot of SPOTS) {
            expect(isBlocked(spot.x, spot.y)).toBe(false);
            expect(findPath(ENTRANCE, spot).length).toBeGreaterThan(0);
        }
        for (const seat of DESK_SEATS) {
            for (const spot of SPOTS) {
                if (spot.x === seat.x && spot.y === seat.y) continue;
                expect(findPath(seat, spot).length).toBeGreaterThan(0);
            }
        }
    });

    it('walks around walls and furniture, one tile at a time', () => {
        const pantrySeat = SPOTS.find(s => s.id === 'snack_1')!;
        const path = findPath(DESK_SEATS[0], pantrySeat);
        let prev = DESK_SEATS[0];
        for (const step of path) {
            expect(Math.abs(step.x - prev.x) + Math.abs(step.y - prev.y)).toBe(1);
            if (step !== path[path.length - 1]) expect(isWalkable(step.x, step.y)).toBe(true);
            prev = step;
        }
        expect(path[path.length - 1]).toEqual({ x: pantrySeat.x, y: pantrySeat.y });
    });
});

function makeBody(seat = DESK_SEATS[0], at = seat): Body {
    return { x: at.x, y: at.y, direction: 'down', activity: 'stand', pose: 'stand', energy: 1, deskX: seat.x, deskY: seat.y };
}

/** Runs the controller until `done` holds (or fails after maxSteps). */
function runUntil(life: OfficeLife, bodies: Map<string, Body>, inputs: Record<string, LifeInput>, done: () => boolean, clock: { now: number }, maxSteps = 400) {
    for (let i = 0; i < maxSteps && !done(); i++) {
        clock.now += STEP_MS;
        life.step(bodies, id => inputs[id], clock.now);
    }
    expect(done()).toBe(true);
}

describe('OfficeLife', () => {
    const fixedRng = () => 0.1;

    it('walks a working agent to its desk and sits down to type', () => {
        const life = new OfficeLife(fixedRng);
        const body = makeBody(DESK_SEATS[0], ENTRANCE);
        const bodies = new Map([['a', body]]);
        life.add('a', body);
        const clock = { now: 0 };
        runUntil(life, bodies, { a: { action: 'work' } }, () => body.activity === 'type', clock);
        expect(body).toMatchObject({ x: DESK_SEATS[0].x, y: DESK_SEATS[0].y, pose: 'sit', direction: 'up' });
    });

    it('takes a coffee break, then rests, then goes back to work when energy runs low', () => {
        const life = new OfficeLife(fixedRng);
        const body = makeBody();
        const bodies = new Map([['a', body]]);
        life.add('a', body);
        body.energy = BREAK_THRESHOLD - 0.05;
        const clock = { now: 0 };
        const inputs = { a: { action: 'work' } };

        runUntil(life, bodies, inputs, () => body.activity === 'drink', clock);
        expect(life.isOnBreak('a')).toBe(true);
        runUntil(life, bodies, inputs, () => body.activity === 'snack' || body.activity === 'lounge', clock);
        expect(body.pose).toBe('sit');
        runUntil(life, bodies, inputs, () => body.activity === 'type', clock);
        expect(life.isOnBreak('a')).toBe(false);
        expect(body.energy).toBeGreaterThan(0.6);
    });

    it('cuts a break short when the user is waiting', () => {
        const life = new OfficeLife(fixedRng);
        const body = makeBody();
        const bodies = new Map([['a', body]]);
        life.add('a', body);
        body.energy = 0.1;
        const clock = { now: 0 };
        runUntil(life, bodies, { a: { action: 'idle' } }, () => body.activity === 'drink', clock);
        runUntil(life, bodies, { a: { action: 'idle', urgent: true } }, () => !life.isOnBreak('a') && body.x === body.deskX && body.y === body.deskY, clock);
    });

    it('walks over to stand next to the teammate it talks to', () => {
        const life = new OfficeLife(fixedRng);
        const a = makeBody(DESK_SEATS[0]);
        const b = makeBody(DESK_SEATS[5]);
        const bodies = new Map([['a', a], ['b', b]]);
        life.add('a', a);
        life.add('b', b);
        const clock = { now: 0 };
        runUntil(life, bodies, { a: { action: 'talk', talkTo: 'b' }, b: { action: 'work' } },
            () => a.activity === 'talk' && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1, clock);
        expect(a.pose).toBe('stand');
    });

    it('goes to the whiteboard to plan and to the reviewer during review', () => {
        const life = new OfficeLife(fixedRng);
        const a = makeBody(DESK_SEATS[0]);
        const qa = makeBody(DESK_SEATS[6]);
        const bodies = new Map([['a', a], ['qa', qa]]);
        life.add('a', a);
        life.add('qa', qa);
        const clock = { now: 0 };
        runUntil(life, bodies, { a: { action: 'work', phase: 'plan' }, qa: { action: 'work' } }, () => a.activity === 'present', clock);
        expect(SPOTS.find(s => s.kind === 'whiteboard' && s.x === a.x && s.y === a.y)).toBeDefined();
        runUntil(life, bodies, { a: { action: 'talk', phase: 'review', reviewerId: 'qa' }, qa: { action: 'work' } },
            () => a.activity === 'talk' && Math.abs(a.x - qa.x) + Math.abs(a.y - qa.y) === 1, clock);
    });

    it('never puts two agents on the same shared spot', () => {
        const life = new OfficeLife(fixedRng);
        const bodies = new Map<string, Body>();
        const inputs: Record<string, LifeInput> = {};
        DESK_SEATS.slice(0, 6).forEach((seat, i) => {
            const body = makeBody(seat);
            bodies.set(`a${i}`, body);
            life.add(`a${i}`, body);
            body.energy = 0.1;
            inputs[`a${i}`] = { action: 'idle' };
        });
        const clock = { now: 0 };
        for (let i = 0; i < 200; i++) {
            clock.now += STEP_MS;
            life.step(bodies, id => inputs[id], clock.now);
            const settled = Array.from(bodies.values()).filter(b => b.activity !== 'walk' && !(b.x === b.deskX && b.y === b.deskY));
            const tiles = settled.map(b => `${b.x},${b.y}`);
            expect(new Set(tiles).size).toBe(tiles.length);
        }
    });
});

describe('Semaphore', () => {
    it('queues callers beyond the limit and hands released slots to them in order', async () => {
        const slots = new Semaphore(1);
        expect(slots.tryAcquire()).toBe(true);
        const order: string[] = [];
        const first = slots.acquire().then(() => order.push('first'));
        const second = slots.acquire().then(() => order.push('second'));
        expect(slots.tryAcquire()).toBe(false);
        expect(slots.tryAcquire(1)).toBe(true); // urgent work may go one over
        slots.release(); // back at the limit: nobody is let in yet
        await Promise.resolve();
        expect(order).toEqual([]);
        slots.release();
        await first;
        slots.release();
        await second;
        expect(order).toEqual(['first', 'second']);
        slots.release();
        expect(slots.inUse).toBe(0);
    });
});
