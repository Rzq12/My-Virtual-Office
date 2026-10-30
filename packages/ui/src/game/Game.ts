import Phaser from 'phaser';
import * as Colyseus from 'colyseus.js';
import { OfficeState, AgentState } from './schema';
import { eventBus } from '../events';
import { officeStore, tasksFromRows, subscribe, getSnapshot } from '../store';

let activeRoom: Colyseus.Room<OfficeState> | undefined;

const CHARACTER_SHEETS = 6;
const RECONNECT_DELAY_MS = 3000;
// One tile step on the server (STEP_MS in packages/server/src/behavior.ts); each step is tweened over the same time.
const STEP_MS = 300;
// Sprites are drawn this much lower while seated so the character sinks into the chair.
const SIT_OFFSET = 6;
// Sheet layout (pixel-agents format): rows down/up/right; per row walk 0-2, type 3-4, read 5-6.
const SHEET_ROWS = { down: 0, up: 7, right: 14 } as const;
const ACTIVITY_EMOTES: Record<string, string> = {
    type: '💻', read: '📖', talk: '💬', present: '📊', drink: '☕', snack: '🍩', lounge: '😌'
};
// Break emotes stay up for the whole break; the others fade after a few seconds.
const LASTING_EMOTES = ['drink', 'snack', 'lounge'];
const PHASE_EMOTES: Record<string, string> = { plan: '📝', research: '🔎', execute: '⌨️', review: '🤝', finalize: '🖨️' };
// Tints for agents beyond the six base sprites so every teammate looks distinct.
const SPRITE_TINTS = [0xffffff, 0xffc9c9, 0xc9e4ff, 0xd4ffc9, 0xfff1c9, 0xe9c9ff];
const LABEL_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
// Text is rasterised at this multiple so it stays sharp up to the max camera zoom (4x) on HiDPI screens.
const TEXT_RESOLUTION = Math.min(8, Math.ceil((typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1) * 4));

/** Zoom that fits the whole square office into a viewport of the given size. */
export function fitZoom(viewWidth: number, viewHeight: number, worldSize: number): number {
    const zoom = Math.min(viewWidth, viewHeight) / worldSize;
    return Math.max(0.5, Math.min(3, Math.floor(zoom * 20) / 20));
}

export function getColyseusRoom() {
    return activeRoom;
}

function resolveWsEndpoint(): string {
    if (typeof window !== 'undefined') {
        const queryWs = new URLSearchParams(window.location.search).get('ws');
        if (queryWs && queryWs.trim()) {
            window.localStorage.setItem('agent-office:ws-url', queryWs.trim());
            return queryWs.trim();
        }
        const savedWs = window.localStorage.getItem('agent-office:ws-url');
        if (savedWs && savedWs.trim()) return savedWs.trim();
    }
    const globalEndpoint = typeof window !== 'undefined'
        ? (window as any).__AGENT_OFFICE_WS_URL as string | undefined
        : undefined;
    if (globalEndpoint && globalEndpoint.trim()) return globalEndpoint.trim();
    if (typeof window !== 'undefined') {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.hostname}:3000`;
    }
    return 'ws://localhost:3000';
}

export class OfficeScene extends Phaser.Scene {
    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private room?: Colyseus.Room;
    private agentSprites: Map<string, Phaser.GameObjects.Container> = new Map();
    private deskGraphics?: Phaser.GameObjects.Graphics;
    private deskLabels: Map<string, Phaser.GameObjects.Text> = new Map();
    private bubbleDepth = 20;
    private userZoomed = false;
    private followTarget: Phaser.GameObjects.Container | null = null;
    private cinematicMode = true;
    private cinematicReleaseAt = 0;
    private customLayoutLayer?: Phaser.GameObjects.Container;
    private layoutItems: Array<{ id: string; type: string; x: number; y: number; label?: string }> = [];
    private layoutEditMode = false;
    private layoutDragItemId: string | null = null;
    private gridSize = 40 * 16;
    private heldMoveKeys: Set<'left' | 'right' | 'up' | 'down'> = new Set();
    /** Per-agent movement, advanced every frame from update(). */
    private walkTicks: Map<string, (deltaMs: number) => void> = new Map();

    constructor() {
        super('OfficeScene');
    }

    preload() {
        for (let i = 0; i < CHARACTER_SHEETS; i++) {
            this.load.spritesheet(`char_${i}`, `/assets/characters/char_${i}.png`, {
                frameWidth: 16,
                frameHeight: 32
            });
        }
    }

    create() {
        try {
            // pixelArt mode scales textures with nearest-neighbour, which turns small text into a smear
            // at non-integer zoom. Render every Text at high resolution with smooth filtering instead.
            this.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, (obj: Phaser.GameObjects.GameObject) => {
                if (obj instanceof Phaser.GameObjects.Text && obj.style.resolution !== TEXT_RESOLUTION) {
                    obj.setResolution(TEXT_RESOLUTION);
                    obj.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
                }
            });

            const anims = this.anims;
            for (let i = 0; i < CHARACTER_SHEETS; i++) {
                const key = `char_${i}`;
                if (!this.textures.exists(key)) continue;
                for (const [dir, row] of Object.entries(SHEET_ROWS)) {
                    anims.create({ key: `${key}-walk-${dir}`, frames: anims.generateFrameNumbers(key, { frames: [row, row + 1, row + 2, row + 1] }), frameRate: 10, repeat: -1 });
                    anims.create({ key: `${key}-type-${dir}`, frames: anims.generateFrameNumbers(key, { frames: [row + 3, row + 4] }), frameRate: 5, repeat: -1 });
                    anims.create({ key: `${key}-read-${dir}`, frames: anims.generateFrameNumbers(key, { frames: [row + 5, row + 6] }), frameRate: 2, repeat: -1 });
                }
            }

            const gridSize = this.gridSize;
            const g = this.add.graphics();

            // ═══════════════════════════════════════════
            //  FLOORING
            // ═══════════════════════════════════════════

            // Main office floor (warm grey carpet)
            g.fillStyle(0x2d2d3d, 1);
            g.fillRect(0, 0, gridSize, gridSize);

            // Work area floor (slightly lighter)
            g.fillStyle(0x33334a, 1);
            g.fillRect(16, 16, gridSize - 32, gridSize - 32);

            // Meeting room carpet (purple-tinted)
            g.fillStyle(0x352a45, 1);
            g.fillRect(32, 32, 200, 160);

            // Collab area carpet (warm orange-tinted)
            g.fillStyle(0x3d3025, 1);
            g.fillRect(280, 32, 200, 160);

            // Coffee area tiles (subtle checkerboard)
            for (let tx = 0; tx < 11; tx++) {
                for (let ty = 0; ty < 11; ty++) {
                    g.fillStyle((tx + ty) % 2 === 0 ? 0x2a3a2a : 0x253025, 1);
                    g.fillRect(350 + tx * 16, 350 + ty * 16, 16, 16);
                }
            }

            // ═══════════════════════════════════════════
            //  WALLS & PARTITIONS
            // ═══════════════════════════════════════════

            // Meeting room walls
            g.lineStyle(3, 0x6c5ce7, 0.9);
            g.strokeRect(32, 32, 200, 160);
            // Door gaps line up with the walkable door tiles in packages/server/src/officeMap.ts.
            // Door gap (bottom-right of meeting room)
            g.fillStyle(0x33334a, 1);
            g.fillRect(185, 189, 46, 6);

            // Collab area walls
            g.lineStyle(3, 0xe17055, 0.9);
            g.strokeRect(280, 32, 200, 160);
            // Door gap (bottom-left)
            g.fillStyle(0x33334a, 1);
            g.fillRect(282, 189, 30, 6);

            // Coffee area border
            g.lineStyle(2, 0x00b894, 0.7);
            g.strokeRect(350, 350, 176, 176);
            // Door gap
            g.fillStyle(0x33334a, 1);
            g.fillRect(347, 409, 6, 30);

            // Entrance at the top of the hallway between the meeting room and the collab area
            g.fillStyle(0x6d4c2e, 1);
            g.fillRect(250, 0, 12, 10);
            g.fillStyle(0x8b6a4a, 1);
            g.fillRect(248, 12, 16, 8); // door mat

            // Room labels
            this.add.text(132, 46, '🏢 Meeting Room', { fontFamily: LABEL_FONT, fontSize: '10px', color: '#b8a9d4' }).setOrigin(0.5);
            this.add.text(380, 46, '💡 Collab Area', { fontFamily: LABEL_FONT, fontSize: '10px', color: '#e8a87c' }).setOrigin(0.5);
            this.add.text(438, 364, '☕ Coffee & Pantry', { fontFamily: LABEL_FONT, fontSize: '10px', color: '#7fcdaa' }).setOrigin(0.5);

            // ═══════════════════════════════════════════
            //  MEETING ROOM FURNITURE
            // ═══════════════════════════════════════════

            // Large meeting table
            g.fillStyle(0x6d4c2e, 1);
            g.fillRect(72, 72, 112, 64);
            g.fillStyle(0x7d5c3e, 1);
            g.fillRect(76, 76, 104, 56); // table top highlight

            // Chairs around meeting table, on the meeting seat tiles agents sit on
            const chairColor = 0x4a4a6a;
            const chairs = [[96, 64], [128, 64], [160, 64], // top row
            [96, 144], [128, 144], [160, 144], // bottom row
            [64, 96], [64, 128], // left
            [192, 96], [192, 128]]; // right
            chairs.forEach(([cx, cy]) => {
                g.fillStyle(chairColor, 1);
                g.fillCircle(cx, cy, 6);
                g.fillStyle(0x5a5a7a, 1);
                g.fillCircle(cx, cy, 4);
            });

            // Whiteboard on meeting room wall
            g.fillStyle(0xdfe6e9, 1);
            g.fillRect(48, 36, 60, 30);
            g.lineStyle(2, 0x636e72, 1);
            g.strokeRect(48, 36, 60, 30);
            // Whiteboard scribbles
            g.lineStyle(1, 0x0984e3, 0.6);
            g.beginPath();
            g.moveTo(54, 46); g.lineTo(70, 42); g.lineTo(85, 50); g.lineTo(100, 44);
            g.strokePath();
            g.lineStyle(1, 0xd63031, 0.6);
            g.beginPath();
            g.moveTo(54, 54); g.lineTo(75, 58); g.lineTo(95, 52);
            g.strokePath();

            // ═══════════════════════════════════════════
            //  COLLAB AREA FURNITURE
            // ═══════════════════════════════════════════

            // Standing desks (2 side by side)
            g.fillStyle(0x5a3e28, 1);
            g.fillRect(300, 70, 48, 28);
            g.fillStyle(0x6a4e38, 1);
            g.fillRect(302, 72, 44, 24);

            g.fillStyle(0x5a3e28, 1);
            g.fillRect(410, 70, 48, 28);
            g.fillStyle(0x6a4e38, 1);
            g.fillRect(412, 72, 44, 24);

            // Laptops on standing desks
            const drawLaptop = (lx: number, ly: number) => {
                g.fillStyle(0x636e72, 1);
                g.fillRect(lx, ly, 16, 10); // screen
                g.fillStyle(0x2d3436, 1);
                g.fillRect(lx + 1, ly + 1, 14, 8);
                g.fillStyle(0x636e72, 1);
                g.fillRect(lx - 1, ly + 10, 18, 3); // keyboard
            };
            drawLaptop(312, 76);
            drawLaptop(424, 76);

            // Bean bags / lounge chairs in collab
            g.fillStyle(0xe17055, 0.6);
            g.fillCircle(320, 144, 14);
            g.fillStyle(0xfdcb6e, 0.6);
            g.fillCircle(368, 160, 14);
            g.fillStyle(0x6c5ce7, 0.6);
            g.fillCircle(432, 144, 14);

            // Work desks are drawn per agent in drawWorkstation() once the roster arrives.
            this.deskGraphics = this.add.graphics();
            this.deskGraphics.setDepth(1);

            // ═══════════════════════════════════════════
            //  COFFEE & PANTRY AREA
            // ═══════════════════════════════════════════

            // Counter
            g.fillStyle(0x5a3e28, 1);
            g.fillRect(370, 380, 80, 20);
            g.fillStyle(0x6d4c2e, 1);
            g.fillRect(372, 382, 76, 16);

            // Coffee machine
            g.fillStyle(0x2d3436, 1);
            g.fillRect(380, 370, 20, 24);
            g.fillStyle(0x636e72, 1);
            g.fillRect(382, 372, 16, 12);
            g.fillStyle(0xd63031, 1);
            g.fillCircle(390, 390, 2); // power light

            // Microwave
            g.fillStyle(0xdfe6e9, 1);
            g.fillRect(410, 372, 20, 16);
            g.fillStyle(0x2d3436, 1);
            g.fillRect(412, 374, 12, 12);
            g.fillStyle(0x00b894, 1);
            g.fillRect(427, 376, 2, 2); // light

            // Small table with snacks
            g.fillStyle(0x5a3e28, 1);
            g.fillRect(376, 440, 48, 32);
            g.fillStyle(0x6d4c2e, 1);
            g.fillRect(378, 442, 44, 28);
            // Fruit bowl
            g.fillStyle(0xfdcb6e, 1);
            g.fillCircle(392, 452, 4);
            g.fillStyle(0xe17055, 1);
            g.fillCircle(400, 450, 3);
            g.fillStyle(0x00b894, 1);
            g.fillCircle(408, 454, 4);

            // Chairs around snack table
            g.fillStyle(0x4a4a6a, 1);
            g.fillCircle(368, 448, 5);
            g.fillCircle(368, 464, 5);
            g.fillCircle(432, 448, 5);
            g.fillCircle(432, 464, 5);

            // Water cooler
            g.fillStyle(0x74b9ff, 0.6);
            g.fillRect(470, 380, 12, 24);
            g.fillStyle(0xdfe6e9, 1);
            g.fillRect(468, 404, 16, 16);
            g.fillStyle(0x74b9ff, 0.4);
            g.fillRect(470, 382, 8, 16); // water level
            this.add.text(476, 424, '💧', { fontSize: '8px' }).setOrigin(0.5);

            // ═══════════════════════════════════════════
            //  DECORATIONS
            // ═══════════════════════════════════════════

            // Potted plants
            const drawPlant = (px: number, py: number) => {
                // Pot
                g.fillStyle(0x8b4513, 1);
                g.fillRect(px - 5, py, 10, 8);
                g.fillStyle(0xa0522d, 1);
                g.fillRect(px - 4, py + 1, 8, 6);
                // Soil
                g.fillStyle(0x3e2723, 1);
                g.fillRect(px - 3, py, 6, 2);
                // Leaves
                g.fillStyle(0x27ae60, 1);
                g.fillCircle(px, py - 4, 6);
                g.fillStyle(0x2ecc71, 1);
                g.fillCircle(px - 3, py - 6, 4);
                g.fillCircle(px + 4, py - 5, 4);
            };

            drawPlant(24, 210);   // near desks
            drawPlant(140, 210);  // between meeting room and desks
            drawPlant(608, 296);  // right corridor (kept out of the hallway exit)
            drawPlant(530, 380);  // near coffee area
            drawPlant(24, 500);   // bottom left
            drawPlant(550, 200);  // right side

            // Bookshelf on right wall
            g.fillStyle(0x5a3e28, 1);
            g.fillRect(540, 50, 40, 80);
            g.fillStyle(0x6d4c2e, 1);
            g.fillRect(542, 52, 36, 18); // shelf 1
            g.fillRect(542, 72, 36, 18); // shelf 2
            g.fillRect(542, 92, 36, 18); // shelf 3
            // Books
            const bookColors = [0xd63031, 0x0984e3, 0xfdcb6e, 0x00b894, 0x6c5ce7, 0xe17055];
            for (let b = 0; b < 6; b++) {
                g.fillStyle(bookColors[b], 1);
                g.fillRect(544 + b * 5, 54, 4, 14);
            }
            for (let b = 0; b < 5; b++) {
                g.fillStyle(bookColors[b + 1], 1);
                g.fillRect(544 + b * 6, 74, 4, 14);
            }

            // Printer
            g.fillStyle(0xdfe6e9, 1);
            g.fillRect(540, 140, 30, 18);
            g.fillStyle(0xb2bec3, 1);
            g.fillRect(542, 142, 26, 10);
            g.fillStyle(0x2d3436, 1);
            g.fillRect(545, 155, 6, 2); // paper slot
            this.add.text(555, 164, '🖨️', { fontSize: '8px' }).setOrigin(0.5);

            // ═══════════════════════════════════════════
            //  SUBTLE GRID (very faint)
            // ═══════════════════════════════════════════
            g.lineStyle(1, 0x444466, 0.12);
            g.beginPath();
            for (let i = 0; i <= gridSize; i += 16) {
                g.moveTo(i, 0).lineTo(i, gridSize);
                g.moveTo(0, i).lineTo(gridSize, i);
            }
            g.strokePath();

            this.cameras.main.setBackgroundColor('#16213e');
            this.cameras.main.setZoom(fitZoom(this.scale.width, this.scale.height, gridSize));
            this.cameras.main.centerOn(gridSize / 2, gridSize / 2);
            this.scale.on(Phaser.Scale.Events.RESIZE, (size: Phaser.Structs.Size) => {
                if (!this.userZoomed) this.cameras.main.setZoom(fitZoom(size.width, size.height, gridSize));
            });
            this.customLayoutLayer = this.add.container(0, 0);
            this.customLayoutLayer.setDepth(4);

            // Follow whichever agent is focused from the UI (team list) or by clicking a sprite.
            let lastFocus: string | null = null;
            const unsubscribe = subscribe(() => {
                const focusedId = getSnapshot().focusedId;
                if (focusedId === lastFocus) return;
                this.setFocusRing(lastFocus, false);
                lastFocus = focusedId;
                this.setFocusRing(focusedId, true);
                this.followTarget = focusedId ? this.agentSprites.get(focusedId) || null : null;
                this.cinematicReleaseAt = 0;
            });
            this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsubscribe);

            if (this.input.keyboard) {
                this.cursors = this.input.keyboard.createCursorKeys();
            }

            eventBus.addEventListener('cinematic-toggle', (e: Event) => {
                const detail = (e as CustomEvent).detail as { enabled: boolean };
                this.cinematicMode = Boolean(detail?.enabled);
                if (!this.cinematicMode) {
                    this.cinematicReleaseAt = 0;
                }
            });
            eventBus.addEventListener('layout-preview-update', (e: Event) => {
                const detail = (e as CustomEvent).detail as { items: Array<{ id: string; type: string; x: number; y: number; label?: string }> };
                this.layoutItems = Array.isArray(detail?.items) ? detail.items : [];
                this.renderCustomLayout(this.layoutItems);
            });
            eventBus.addEventListener('layout-edit-mode', (e: Event) => {
                const detail = (e as CustomEvent).detail as { enabled: boolean };
                this.layoutEditMode = Boolean(detail?.enabled);
                if (!this.layoutEditMode) this.layoutDragItemId = null;
            });

            this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
                if (!this.layoutEditMode || !this.layoutDragItemId || !pointer.isDown) return;
                const gx = Phaser.Math.Clamp(Math.round(pointer.worldX / 16), 2, 36);
                const gy = Phaser.Math.Clamp(Math.round(pointer.worldY / 16), 2, 36);
                this.layoutItems = this.layoutItems.map((item) =>
                    item.id === this.layoutDragItemId ? { ...item, x: gx, y: gy } : item
                );
                this.renderCustomLayout(this.layoutItems);
                eventBus.dispatchEvent(new CustomEvent('layout-item-moved', { detail: { items: this.layoutItems } }));
            });
            this.input.on('pointerup', () => {
                this.layoutDragItemId = null;
            });
            this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _objects: Phaser.GameObjects.GameObject[], _deltaX: number, deltaY: number) => {
                const minZoom = fitZoom(this.scale.width, this.scale.height, this.gridSize) * 0.8;
                const nextZoom = Phaser.Math.Clamp(this.cameras.main.zoom - deltaY * 0.001, minZoom, 4);
                this.cameras.main.setZoom(nextZoom);
                this.userZoomed = true;
            });

            const toMoveDirection = (event: KeyboardEvent): 'left' | 'right' | 'up' | 'down' | null => {
                const key = (event.key || '').toLowerCase();
                const code = (event.code || '').toLowerCase();
                if (key === 'arrowleft' || key === 'a' || code === 'arrowleft' || code === 'keya') return 'left';
                if (key === 'arrowright' || key === 'd' || code === 'arrowright' || code === 'keyd') return 'right';
                if (key === 'arrowup' || key === 'w' || code === 'arrowup' || code === 'keyw') return 'up';
                if (key === 'arrowdown' || key === 's' || code === 'arrowdown' || code === 'keys') return 'down';
                return null;
            };

            const keyDownHandler = (event: KeyboardEvent) => {
                const dir = toMoveDirection(event);
                if (!dir) return;
                const active = document.activeElement as HTMLElement | null;
                const isEditable = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' || active?.isContentEditable;
                if (isEditable) return;
                this.heldMoveKeys.add(dir);
                event.preventDefault();
            };
            const keyUpHandler = (event: KeyboardEvent) => {
                const dir = toMoveDirection(event);
                if (!dir) return;
                this.heldMoveKeys.delete(dir);
            };
            window.addEventListener('keydown', keyDownHandler, { capture: true });
            window.addEventListener('keyup', keyUpHandler, { capture: true });
            document.addEventListener('keydown', keyDownHandler, { capture: true });
            document.addEventListener('keyup', keyUpHandler, { capture: true });
            window.addEventListener('blur', () => this.heldMoveKeys.clear());
            this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
                window.removeEventListener('keydown', keyDownHandler, true);
                window.removeEventListener('keyup', keyUpHandler, true);
                document.removeEventListener('keydown', keyDownHandler, true);
                document.removeEventListener('keyup', keyUpHandler, true);
                this.heldMoveKeys.clear();
            });

            this.connectToServer();
        } catch (e) {
            console.error("CRITICAL PHASER ERROR", e);
        }
    }

    /** Drops the previous room's sprites and desks so a reconnect starts from a clean scene. */
    private resetAgents() {
        this.agentSprites.forEach(sprite => sprite.destroy());
        this.agentSprites.clear();
        this.walkTicks.clear();
        this.deskLabels.forEach(label => label.destroy());
        this.deskLabels.clear();
        this.deskGraphics?.clear();
        this.followTarget = null;
        getSnapshot().agents.forEach(agent => officeStore.removeAgent(agent.id));
    }

    /** Retries after a delay; the server is often restarted while the page stays open. */
    private scheduleReconnect(wsEndpoint: string) {
        officeStore.setConnection('error', wsEndpoint);
        activeRoom = undefined;
        this.time.delayedCall(RECONNECT_DELAY_MS, () => this.connectToServer());
    }

    async connectToServer() {
        const wsEndpoint = resolveWsEndpoint();
        try {
            officeStore.setConnection('connecting', wsEndpoint);
            const client = new Colyseus.Client(wsEndpoint);
            this.room = await client.joinOrCreate('office');
            const room = this.room;
            this.resetAgents();
            activeRoom = room as Colyseus.Room<OfficeState>;
            officeStore.setConnection('connected', wsEndpoint);
            room.onLeave(() => this.scheduleReconnect(wsEndpoint));
            room.onError(() => officeStore.setConnection('error', wsEndpoint));

            // Register every message handler right after joining: the server sends history,
            // tasks and layout from onJoin, and anything without a handler is dropped.
            room.onMessage('chat', (message: any) => officeStore.addChat(message));
            room.onMessage('llm-options', (options: any) => officeStore.setProviders(Array.isArray(options?.providers) ? options.providers : []));
            room.onMessage('model-error', (message: any) => officeStore.addChat({ sender: 'System', text: `⚠️ ${message?.error || 'Could not change the model.'}` }));
            room.onMessage('chat-history', (messages: any) => officeStore.setChat(Array.isArray(messages) ? messages : []));
            room.onMessage('tasks-sync', (rows: any) => officeStore.setTasks(tasksFromRows(rows)));
            room.onMessage('task-update', (task: any) => officeStore.upsertTask({
                id: Number(task.id),
                title: String(task.title || ''),
                agentId: String(task.agentId || ''),
                status: task.status,
                summary: task.summary
            }));
            room.onMessage('workflow-update', (update: any) => officeStore.setTaskPhase(
                Number(update?.taskId),
                String(update?.phase || ''),
                String(update?.detail || '')
            ));
            room.onMessage('highlight-history', (items: any) => {
                if (!Array.isArray(items)) return;
                [...items].reverse().forEach(item => eventBus.dispatchEvent(new CustomEvent('highlight-event', { detail: item })));
            });
            room.onMessage('highlight-event', (message: any) => {
                eventBus.dispatchEvent(new CustomEvent('highlight-event', { detail: message }));
                if (this.cinematicMode && message?.agentId) {
                    this.focusAgentTemporarily(message.agentId);
                }
            });
            room.onMessage('scenario-event', (message: any) => {
                eventBus.dispatchEvent(new CustomEvent('scenario-event', { detail: message }));
            });
            room.onMessage('relationship-update', (message: any) => {
                eventBus.dispatchEvent(new CustomEvent('relationship-update', { detail: message }));
            });
            room.onMessage('layout-sync', (message: any) => {
                this.layoutItems = Array.isArray(message?.layout) ? message.layout : [];
                this.renderCustomLayout(this.layoutItems);
                eventBus.dispatchEvent(new CustomEvent('layout-sync', { detail: { items: this.layoutItems } }));
            });
            room.onStateChange((state: any) => officeStore.setEngine(String(state.engine || '')));

            // Wait for the first actual state payload from the server before reading agents
            room.onStateChange.once((state: any) => {
                state.agents.onAdd((agent: AgentState, sessionId: string) => {
                    const container = this.add.container(agent.x * 16, agent.y * 16);
                    container.setDepth(10);
                    this.drawWorkstation(sessionId, agent.deskX, agent.deskY, agent.role || agent.name);

                    const spriteIndex = Number(agent.sprite || 0);
                    const charKey = `char_${spriteIndex % CHARACTER_SHEETS}`;
                    // Feet-anchored so seating offsets and the breathing tween keep the feet in place.
                    let sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Rectangle;
                    if (this.textures.exists(charKey)) {
                        sprite = this.add.sprite(0, 8, charKey, SHEET_ROWS.down + 1).setOrigin(0.5, 1);
                        const tint = SPRITE_TINTS[Math.floor(spriteIndex / CHARACTER_SHEETS) % SPRITE_TINTS.length];
                        if (tint !== 0xffffff) sprite.setTint(tint);
                    } else {
                        sprite = this.add.rectangle(0, 8, 16, 32, 0x3a86ff).setOrigin(0.5, 1);
                    }
                    const energyBar = this.add.graphics();

                    // Thought bubble (word-wrapped)
                    const thoughtBubble = this.add.text(0, -26, '', {
                        fontFamily: LABEL_FONT,
                        fontSize: '9px',
                        color: '#ffffff',
                        backgroundColor: '#14163af2',
                        padding: { x: 5, y: 3 },
                        align: 'center',
                        wordWrap: { width: 110, useAdvancedWrap: true }
                    }).setOrigin(0.5, 1);
                    thoughtBubble.setVisible(false);

                    // Emote bubble (emoji above head)
                    const emoteBubble = this.add.text(8, -24, '', {
                        fontSize: '12px'
                    }).setOrigin(0.5);
                    emoteBubble.setVisible(false);

                    // Name label
                    const label = this.add.text(0, 9, agent.name, {
                        fontFamily: LABEL_FONT,
                        fontSize: '8px', fontStyle: 'bold', color: '#ffffff',
                        backgroundColor: '#0b0c1ee6', padding: { x: 3, y: 1 }
                    }).setOrigin(0.5, 0);

                    // Focus highlight ring (hidden by default)
                    const focusRing = this.add.graphics();
                    focusRing.lineStyle(1.5, 0xa29bfe, 1);
                    focusRing.strokeCircle(0, -6, 13);
                    focusRing.setVisible(false);

                    container.add([focusRing, sprite, thoughtBubble, emoteBubble, label, energyBar]);
                    container.setSize(20, 34);
                    container.setInteractive(new Phaser.Geom.Rectangle(-10, -24, 20, 34), Phaser.Geom.Rectangle.Contains);
                    this.agentSprites.set(sessionId, container);
                    if (getSnapshot().focusedId === sessionId) {
                        focusRing.setVisible(true);
                        this.followTarget = container;
                    }

                    // --- FOCUS MODE: click to follow, click again to release ---
                    container.on('pointerdown', () => {
                        if (this.layoutEditMode) return;
                        officeStore.setFocused(getSnapshot().focusedId === sessionId ? null : sessionId);
                    });

                    const publish = () => officeStore.upsertAgent({
                        id: sessionId,
                        name: agent.name,
                        role: agent.role || '',
                        action: agent.action,
                        currentTask: agent.currentTask || '',
                        thought: agent.thought || '',
                        mood: Number(agent.mood || 0),
                        reputation: Number(agent.reputation || 0),
                        riskLevel: Number(agent.riskLevel || 0),
                        momentum: Number(agent.momentum || 0),
                        sprite: spriteIndex,
                        provider: agent.provider || '',
                        model: agent.model || '',
                        activity: agent.activity || '',
                        energy: Number(agent.energy ?? 1),
                        phase: agent.phase || ''
                    });
                    publish();
                    let lastThought = agent.thought || '';

                    let prevX = agent.x;
                    let prevY = agent.y;
                    let lastAction = '';
                    let lastActivity = '';
                    let lastPhase = '';
                    let lastEnergyBucket = -1;
                    // Tiles the server has stepped to that the sprite has not reached yet (pixel coordinates).
                    const waypoints: Array<{ x: number; y: number }> = [];
                    let shownPose = '';
                    let breathTween: Phaser.Tweens.Tween | undefined;
                    let emoteTimer: Phaser.Time.TimerEvent | undefined;

                    const showEmote = (text: string, lasting: boolean) => {
                        emoteTimer?.remove();
                        emoteBubble.setText(text).setVisible(true);
                        if (!lasting) emoteTimer = this.time.delayedCall(3500, () => emoteBubble.setVisible(false));
                    };

                    // Standing characters breathe; talkers bob faster. Seated or walking ones hold still.
                    const setBreathing = (activity: string, pose: string) => {
                        breathTween?.stop();
                        breathTween = undefined;
                        sprite.setScale(1, 1);
                        if (pose !== 'stand' || activity === 'walk') return;
                        const talking = activity === 'talk' || activity === 'present';
                        breathTween = this.tweens.add({
                            targets: sprite,
                            scaleY: talking ? 1.05 : 1.025,
                            duration: talking ? 220 : 900,
                            yoyo: true,
                            repeat: -1,
                            ease: 'Sine.easeInOut'
                        });
                    };

                    const drawEnergy = (energy: number) => {
                        const bucket = Math.round(Math.max(0, Math.min(1, energy)) * 20);
                        if (bucket === lastEnergyBucket) return;
                        lastEnergyBucket = bucket;
                        const color = bucket > 10 ? 0x55efc4 : bucket > 5 ? 0xfdcb6e : 0xff7675;
                        energyBar.clear();
                        energyBar.fillStyle(0x0b0c1e, 0.85);
                        energyBar.fillRect(-9, 20, 18, 3);
                        energyBar.fillStyle(color, 1);
                        energyBar.fillRect(-8, 21, Math.max(1, Math.round(16 * bucket / 20)), 1);
                    };
                    drawEnergy(Number(agent.energy ?? 1));

                    /** Walk animation facing the next waypoint, judged from where the sprite is on screen. */
                    const playWalk = (to: { x: number; y: number }) => {
                        sprite.y = 8;
                        if (shownPose !== 'walk') {
                            setBreathing('walk', 'stand');
                            shownPose = 'walk';
                        }
                        if (sprite.type !== 'Sprite') return;
                        const s = sprite as Phaser.GameObjects.Sprite;
                        const dx = to.x - container.x;
                        const dy = to.y - container.y;
                        const horizontal = Math.abs(dx) > Math.abs(dy);
                        s.setFlipX(horizontal && dx < 0);
                        s.anims.timeScale = 1;
                        s.play(`${charKey}-walk-${horizontal ? 'right' : dy < 0 ? 'up' : 'down'}`, true);
                    };

                    const applyPose = () => {
                        // Still walking on screen, or the server is a step ahead: the pose is applied on arrival.
                        if (waypoints.length > 0 || agent.activity === 'walk') return;
                        const activity = agent.activity || 'stand';
                        const pose = agent.pose === 'sit' ? 'sit' : 'stand';
                        sprite.y = pose === 'sit' ? 8 + SIT_OFFSET : 8;
                        if (`${activity}|${pose}` !== shownPose) {
                            setBreathing(activity, pose);
                            shownPose = `${activity}|${pose}`;
                        }
                        if (sprite.type !== 'Sprite') return;
                        const s = sprite as Phaser.GameObjects.Sprite;
                        const dir = agent.direction === 'up' || agent.direction === 'down' ? agent.direction : 'right';
                        s.setFlipX(agent.direction === 'left');
                        if (activity === 'type') s.play(`${charKey}-type-${dir}`, true);
                        else if (['read', 'present', 'drink', 'snack'].includes(activity)) s.play(`${charKey}-read-${dir}`, true);
                        else s.stop().setFrame(SHEET_ROWS[dir] + 1); // standing or sitting still
                        // Sipping coffee and snacking are slower than reading.
                        s.anims.timeScale = activity === 'drink' || activity === 'snack' ? 0.5 : 1;
                    };
                    applyPose();

                    // Moves at a constant speed every frame instead of one tween per server patch, so uneven
                    // patch timing never makes the walk stop and start. Speeds up a little when it falls behind.
                    this.walkTicks.set(sessionId, (deltaMs: number) => {
                        if (waypoints.length === 0) return;
                        let budget = (16 / STEP_MS) * (waypoints.length > 2 ? 1.6 : 1) * deltaMs;
                        while (budget > 0 && waypoints.length > 0) {
                            const target = waypoints[0];
                            const dx = target.x - container.x;
                            const dy = target.y - container.y;
                            const dist = Math.hypot(dx, dy);
                            if (dist <= budget) {
                                container.setPosition(target.x, target.y);
                                budget -= dist;
                                waypoints.shift();
                                if (waypoints.length > 0) playWalk(waypoints[0]);
                            } else {
                                container.x += (dx / dist) * budget;
                                container.y += (dy / dist) * budget;
                                budget = 0;
                            }
                        }
                        if (waypoints.length === 0) applyPose();
                    });

                    agent.onChange(() => {
                        if (agent.x !== prevX || agent.y !== prevY) {
                            const target = { x: agent.x * 16, y: agent.y * 16 };
                            const last = waypoints[waypoints.length - 1] || { x: container.x, y: container.y };
                            if (Math.abs(target.x - last.x) + Math.abs(target.y - last.y) > 16 * 3) {
                                // A jump (reconnect, spawn): place the sprite instead of walking across the office.
                                waypoints.length = 0;
                                container.setPosition(target.x, target.y);
                            } else {
                                waypoints.push(target);
                                if (waypoints.length === 1) playWalk(target);
                            }
                        }
                        applyPose();
                        drawEnergy(Number(agent.energy ?? 1));

                        const activity = agent.activity || '';
                        const phase = agent.phase || '';
                        if (phase && phase !== lastPhase && PHASE_EMOTES[phase]) {
                            showEmote(PHASE_EMOTES[phase], false);
                        } else if (activity !== lastActivity && ACTIVITY_EMOTES[activity]) {
                            showEmote(ACTIVITY_EMOTES[activity], LASTING_EMOTES.includes(activity));
                        } else if (activity !== lastActivity && LASTING_EMOTES.includes(lastActivity)) {
                            emoteBubble.setVisible(false);
                        }

                        // Thought bubble: only when the thought changes, and drawn above other agents
                        // so neighbouring bubbles do not hide each other.
                        const thought = agent.thought || '';
                        if (thought && thought !== lastThought) {
                            thoughtBubble.setText(thought);
                            thoughtBubble.setVisible(true);
                            container.setDepth(++this.bubbleDepth);
                            this.time.delayedCall(6000, () => {
                                if (thoughtBubble.text === thought) thoughtBubble.setVisible(false);
                            });
                        }

                        // --- SYSTEM LOG EVENT ---
                        if (agent.action !== lastAction || thought !== lastThought) {
                            eventBus.dispatchEvent(new CustomEvent('activity-log', {
                                detail: {
                                    agent: agent.name,
                                    action: agent.action,
                                    thought,
                                    time: new Date().toLocaleTimeString()
                                }
                            }));
                        }
                        publish();

                        lastAction = agent.action;
                        lastThought = thought;
                        lastActivity = activity;
                        lastPhase = phase;
                        prevX = agent.x;
                        prevY = agent.y;
                    });
                });

                state.agents.onRemove((agent: AgentState, sessionId: string) => {
                    const sprite = this.agentSprites.get(sessionId);
                    if (sprite) {
                        if (this.followTarget === sprite) this.followTarget = null;
                        sprite.destroy();
                        this.agentSprites.delete(sessionId);
                    }
                    this.walkTicks.delete(sessionId);
                    officeStore.removeAgent(sessionId);
                });
            });

        } catch (e) {
            console.warn(`Cannot reach ${wsEndpoint}; retrying in ${RECONNECT_DELAY_MS / 1000}s`, e);
            this.scheduleReconnect(wsEndpoint);
        }
    }

    private setFocusRing(agentId: string | null, visible: boolean) {
        if (!agentId) return;
        const ring = this.agentSprites.get(agentId)?.getAt(0) as Phaser.GameObjects.Graphics | undefined;
        ring?.setVisible(visible);
    }

    /** Draws a desk with the chair at seat tile (seatX, seatY), where the agent sits. */
    private drawWorkstation(agentId: string, seatX: number, seatY: number, label: string) {
        const g = this.deskGraphics;
        if (!g || this.deskLabels.has(agentId) || !seatX || !seatY) return;
        const x = seatX * 16 - 22;
        const y = seatY * 16 - 38;

        // Desk surface
        g.fillStyle(0x5a3e28, 1);
        g.fillRect(x, y, 56, 28);
        g.fillStyle(0x6d4c2e, 1);
        g.fillRect(x + 2, y + 2, 52, 24);

        // Monitor
        g.fillStyle(0x2d3436, 1);
        g.fillRect(x + 6, y + 3, 22, 14); // bezel
        g.fillStyle(0x74b9ff, 1);
        g.fillRect(x + 8, y + 5, 18, 10); // screen glow
        g.fillStyle(0x636e72, 1);
        g.fillRect(x + 14, y + 17, 10, 3); // stand
        g.fillRect(x + 10, y + 20, 18, 2); // base

        // Keyboard and mouse
        g.fillStyle(0xb2bec3, 1);
        g.fillRect(x + 6, y + 22, 18, 4);
        g.fillRect(x + 28, y + 22, 5, 4);

        // Notepad
        g.fillStyle(0xffeaa7, 1);
        g.fillRect(x + 36, y + 6, 12, 16);
        g.lineStyle(1, 0xfdcb6e, 0.8);
        g.beginPath();
        g.moveTo(x + 38, y + 10); g.lineTo(x + 46, y + 10);
        g.moveTo(x + 38, y + 14); g.lineTo(x + 46, y + 14);
        g.moveTo(x + 38, y + 18); g.lineTo(x + 44, y + 18);
        g.strokePath();

        // Coffee mug
        g.fillStyle(0xd63031, 1);
        g.fillCircle(x + 37, y + 24, 3);
        g.fillStyle(0x2d3436, 1);
        g.fillCircle(x + 37, y + 24, 1.5);

        // Office chair (below desk)
        g.fillStyle(0x2d3436, 1);
        g.fillCircle(x + 22, y + 38, 8);
        g.fillStyle(0x6c5ce7, 1);
        g.fillCircle(x + 22, y + 38, 6);

        const text = this.add.text(x + 28, y - 5, label, { fontFamily: LABEL_FONT, fontSize: '7px', color: '#b8bce0' }).setOrigin(0.5);
        text.setDepth(2);
        this.deskLabels.set(agentId, text);
    }

    update(_time: number, delta: number) {
        this.walkTicks.forEach(tick => tick(delta));
        if (this.cinematicReleaseAt > 0 && Date.now() > this.cinematicReleaseAt) {
            this.cinematicReleaseAt = 0;
            const focusedId = getSnapshot().focusedId;
            this.followTarget = focusedId ? this.agentSprites.get(focusedId) || null : null;
        }
        const speed = 5;
        const manualPan =
            this.heldMoveKeys.size > 0 ||
            Boolean(this.cursors?.left.isDown) ||
            Boolean(this.cursors?.right.isDown) ||
            Boolean(this.cursors?.up.isDown) ||
            Boolean(this.cursors?.down.isDown);
        if (manualPan) {
            // User input should always win over cinematic follow.
            this.followTarget = null;
            this.cinematicReleaseAt = 0;
            officeStore.setFocused(null);
            if (this.cursors?.left.isDown || this.heldMoveKeys.has('left')) this.cameras.main.scrollX -= speed;
            if (this.cursors?.right.isDown || this.heldMoveKeys.has('right')) this.cameras.main.scrollX += speed;
            if (this.cursors?.up.isDown || this.heldMoveKeys.has('up')) this.cameras.main.scrollY -= speed;
            if (this.cursors?.down.isDown || this.heldMoveKeys.has('down')) this.cameras.main.scrollY += speed;
        }
        // Phaser zooms around the camera centre, so the visible world centre is scroll + size / 2.
        const cam = this.cameras.main;
        if (this.followTarget && !manualPan) {
            const targetX = this.followTarget.x - cam.width / 2;
            const targetY = this.followTarget.y - cam.height / 2;
            cam.scrollX += (targetX - cam.scrollX) * 0.08;
            cam.scrollY += (targetY - cam.scrollY) * 0.08;
        }
        cam.scrollX = this.clampScroll(cam.scrollX, cam.width, cam.zoom);
        cam.scrollY = this.clampScroll(cam.scrollY, cam.height, cam.zoom);
    }

    /** Keeps the office on screen; when it is smaller than the viewport it stays centred. */
    private clampScroll(scroll: number, viewSize: number, zoom: number): number {
        const visible = viewSize / zoom;
        const offset = (viewSize - visible) / 2;
        if (visible >= this.gridSize) return this.gridSize / 2 - viewSize / 2;
        return Phaser.Math.Clamp(scroll, -offset, this.gridSize - visible - offset);
    }

    private focusAgentTemporarily(agentId: string) {
        const target = this.agentSprites.get(agentId);
        if (!target) return;
        this.followTarget = target;
        this.cinematicReleaseAt = Date.now() + 7000;
    }

    private renderCustomLayout(items: Array<{ type: string; x: number; y: number; label?: string }>) {
        if (!this.customLayoutLayer) return;
        this.customLayoutLayer.removeAll(true);
        for (let index = 0; index < items.length; index++) {
            const source = items[index] as { id?: string; type: string; x: number; y: number; label?: string };
            const item = {
                ...source,
                id: source.id || `layout_${index}`
            };
            const x = Math.round(item.x) * 16;
            const y = Math.round(item.y) * 16;
            const group = this.add.container(x, y);
            const g = this.add.graphics();
            switch (item.type) {
                case 'plant':
                    g.fillStyle(0x8b4513, 1);
                    g.fillRect(-5, 0, 10, 8);
                    g.fillStyle(0x27ae60, 1);
                    g.fillCircle(0, -5, 6);
                    g.fillStyle(0x2ecc71, 1);
                    g.fillCircle(-3, -7, 4);
                    g.fillCircle(4, -6, 4);
                    break;
                case 'desk':
                    g.fillStyle(0x6d4c2e, 1);
                    g.fillRect(-12, -8, 24, 16);
                    g.fillStyle(0x2d3436, 1);
                    g.fillRect(-8, -6, 10, 6);
                    break;
                case 'bookshelf':
                    g.fillStyle(0x6d4c2e, 1);
                    g.fillRect(-8, -12, 16, 24);
                    g.fillStyle(0xfdcb6e, 1);
                    g.fillRect(-6, -8, 3, 6);
                    g.fillStyle(0x0984e3, 1);
                    g.fillRect(-2, -8, 3, 6);
                    g.fillStyle(0xe17055, 1);
                    g.fillRect(2, -8, 3, 6);
                    break;
                case 'coffee_machine':
                    g.fillStyle(0x2d3436, 1);
                    g.fillRect(-6, -8, 12, 16);
                    g.fillStyle(0xd63031, 1);
                    g.fillCircle(0, 4, 2);
                    break;
                case 'table':
                    g.fillStyle(0x6d4c2e, 1);
                    g.fillRect(-10, -6, 20, 12);
                    break;
                case 'chair':
                    g.fillStyle(0x4a4a6a, 1);
                    g.fillCircle(0, 0, 6);
                    break;
                case 'whiteboard':
                    g.fillStyle(0xdfe6e9, 1);
                    g.fillRect(-10, -6, 20, 12);
                    g.lineStyle(1, 0x636e72, 1);
                    g.strokeRect(-10, -6, 20, 12);
                    break;
                default:
                    g.fillStyle(0xb2bec3, 1);
                    g.fillRect(-6, -6, 12, 12);
            }
            group.add(g);
            if (item.label) {
                const label = this.add.text(0, 10, item.label.slice(0, 8), { fontSize: '8px', color: '#dfe6f3' }).setOrigin(0.5, 0);
                group.add(label);
            }
            group.setSize(22, 22);
            group.setInteractive(new Phaser.Geom.Rectangle(-11, -11, 22, 22), Phaser.Geom.Rectangle.Contains);
            group.on('pointerdown', () => {
                if (!this.layoutEditMode) return;
                this.layoutDragItemId = item.id;
            });
            this.customLayoutLayer.add(group);
        }
    }
}

export function setupPhaser(parentId: string) {
    const config: Phaser.Types.Core.GameConfig = {
        type: Phaser.AUTO,
        parent: parentId,
        width: document.getElementById(parentId)?.clientWidth || window.innerWidth,
        height: document.getElementById(parentId)?.clientHeight || window.innerHeight,
        scene: [OfficeScene],
        pixelArt: true,
        scale: {
            mode: Phaser.Scale.RESIZE,
        },
        input: {
            keyboard: {
                capture: [] // Don't capture ANY keys globally — let React inputs work
            }
        }
    };

    const game = new Phaser.Game(config);

    // When ANY input/textarea/select is focused, fully disable Phaser keyboard
    // When they blur, re-enable it
    document.addEventListener('focusin', (e) => {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            game.input.keyboard?.enabled && (game.input.keyboard.enabled = false);
        }
    });
    document.addEventListener('focusout', (e) => {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            game.input.keyboard && (game.input.keyboard.enabled = true);
        }
    });

    return game;
}
