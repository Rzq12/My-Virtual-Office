/**
 * Counts LLM calls in flight so the social think loop and task workflows share MAX_CONCURRENT_THINKS.
 * Waiters are served first-come first-served; a released slot goes straight to the next waiter.
 */
export class Semaphore {
    private active = 0;
    private waiters: Array<() => void> = [];

    constructor(private readonly max: number) {}

    get inUse(): number {
        return this.active;
    }

    /** Takes a slot if one is free right now. `extra` allows going over the limit by that many (for urgent work). */
    tryAcquire(extra = 0): boolean {
        if (this.active >= this.max + extra || (extra === 0 && this.waiters.length > 0)) return false;
        this.active++;
        return true;
    }

    acquire(): Promise<void> {
        if (this.tryAcquire()) return Promise.resolve();
        return new Promise(resolve => this.waiters.push(resolve));
    }

    release() {
        this.active = Math.max(0, this.active - 1);
        if (this.active >= this.max) return; // still over the limit after an urgent extra slot
        const next = this.waiters.shift();
        if (next) {
            this.active++;
            next();
        }
    }
}
