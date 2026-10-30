import { Schema, MapSchema, type } from '@colyseus/schema';

export class AgentState extends Schema {
    @type('string') id: string;
    @type('string') name: string;
    @type('number') x: number;
    @type('number') y: number;
    @type('string') direction: 'up' | 'down' | 'left' | 'right';
    @type('string') action: string;
    @type('string') currentTask: string;
    @type('string') thought: string;
    @type('number') mood: number;
    @type('number') reputation: number;
    @type('number') riskLevel: number;
    @type('number') momentum: number;
    @type('string') role: string;
    @type('number') deskX: number;
    @type('number') deskY: number;
    @type('number') sprite: number;
    @type('string') provider: string;
    @type('string') model: string;
    /** What the body is doing, for animation: walk, type, read, sit, stand, talk, present, drink, snack, lounge. */
    @type('string') activity: string;
    @type('string') pose: string;
    /** 0-1; drains while working, refilled by breaks in the pantry. */
    @type('number') energy: number;
    /** Current node of the task workflow (plan, research, execute, review, finalize), or ''. */
    @type('string') phase: string;

    constructor(id: string, name: string) {
        super();
        this.id = id;
        this.name = name;
        this.role = '';
        this.deskX = 0;
        this.deskY = 0;
        this.sprite = 0;
        this.provider = '';
        this.model = '';
        this.x = 0;
        this.y = 0;
        this.direction = 'down';
        this.action = 'idle';
        this.currentTask = '';
        this.thought = '';
        this.mood = 0.6;
        this.reputation = 0.5;
        this.riskLevel = 0.2;
        this.momentum = 0.4;
        this.activity = 'stand';
        this.pose = 'stand';
        this.energy = 1;
        this.phase = '';
    }
}

export class OfficeState extends Schema {
    @type({ map: AgentState }) agents = new MapSchema<AgentState>();
    @type('string') officeTime: string = new Date().toISOString();
    @type('number') timeScale: number = 1;
    @type('string') engine: string = '';

    createAgent(id: string, name: string) {
        this.agents.set(id, new AgentState(id, name));
    }

    removeAgent(id: string) {
        this.agents.delete(id);
    }
}
