import Phaser from 'phaser';
import * as Colyseus from 'colyseus.js';
import { OfficeState, AgentState } from './schema';
import { eventBus } from '../events';
import { officeStore, tasksFromRows, subscribe, getSnapshot } from '../store';

let activeRoom: Colyseus.Room<OfficeState> | undefined;

const CHARACTER_SHEETS = 6;
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
                anims.create({ key: `${key}-walk-down`, frames: anims.generateFrameNumbers(key, { start: 0, end: 2 }), frameRate: 8, repeat: -1 });
                anims.create({ key: `${key}-walk-up`, frames: anims.generateFrameNumbers(key, { start: 7, end: 9 }), frameRate: 8, repeat: -1 });
                anims.create({ key: `${key}-walk-right`, frames: anims.generateFrameNumbers(key, { start: 14, end: 16 }), frameRate: 8, repeat: -1 });
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
            // Door gap (bottom-right of meeting room)
            g.fillStyle(0x33334a, 1);
            g.fillRect(192, 188, 40, 6);

            // Collab area walls
            g.lineStyle(3, 0xe17055, 0.9);
            g.strokeRect(280, 32, 200, 160);
            // Door gap
            g.fillStyle(0x33334a, 1);
            g.fillRect(280, 160, 40, 6);

            // Coffee area border
            g.lineStyle(2, 0x00b894, 0.7);
            g.strokeRect(350, 350, 176, 176);
            // Door gap
            g.fillStyle(0x33334a, 1);
            g.fillRect(350, 410, 4, 40);

            // Room labels
            this.add.text(132, 46, '🏢 Meeting Room', { fontFamily: LABEL_FONT, fontSize: '10px', color: '#b8a9d4' }).setOrigin(0.5);
            this.add.text(380, 46, '💡 Collab Area', { fontFamily: LABEL_FONT, fontSize: '10px', color: '#e8a87c' }).setOrigin(0.5);
            this.add.text(438, 364, '☕ Coffee & Pantry', { fontFamily: LABEL_FONT, fontSize: '10px', color: '#7fcdaa' }).setOrigin(0.5);

            // ═══════════════════════════════════════════
            //  MEETING ROOM FURNITURE
            // ═══════════════════════════════════════════

            // Large meeting table
            g.fillStyle(0x6d4c2e, 1);
            g.fillRect(72, 80, 120, 60);
            g.fillStyle(0x7d5c3e, 1);
            g.fillRect(76, 84, 112, 52); // table top highlight

            // Chairs around meeting table (pixel circles)
            const chairColor = 0x4a4a6a;
            const chairs = [[92, 72], [132, 72], [172, 72], // top row
            [92, 148], [132, 148], [172, 148], // bottom row
            [64, 100], [64, 128], // left
            [200, 100], [200, 128]]; // right
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
            g.fillCircle(320, 150, 14);
            g.fillStyle(0xfdcb6e, 0.6);
            g.fillCircle(370, 155, 14);
            g.fillStyle(0x6c5ce7, 0.6);
            g.fillCircle(430, 148, 14);

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
            g.fillRect(380, 440, 40, 30);
            g.fillStyle(0x6d4c2e, 1);
            g.fillRect(382, 442, 36, 26);
            // Fruit bowl
            g.fillStyle(0xfdcb6e, 1);
            g.fillCircle(392, 452, 4);
            g.fillStyle(0xe17055, 1);
            g.fillCircle(400, 450, 3);
            g.fillStyle(0x00b894, 1);
            g.fillCircle(408, 454, 4);

            // Chairs around snack table
            g.fillStyle(0x4a4a6a, 1);
            g.fillCircle(375, 445, 5);
            g.fillCircle(375, 460, 5);
            g.fillCircle(425, 445, 5);
            g.fillCircle(425, 460, 5);

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
            drawPlant(250, 210);  // center
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

    async connectToServer() {
        const wsEndpoint = resolveWsEndpoint();
        try {
            officeStore.setConnection('connecting', wsEndpoint);
            const client = new Colyseus.Client(wsEndpoint);
            this.room = await client.joinOrCreate('office');
            const room = this.room;
            activeRoom = room as Colyseus.Room<OfficeState>;
            officeStore.setConnection('connected', wsEndpoint);
            room.onLeave(() => officeStore.setConnection('error', wsEndpoint));
            room.onError(() => officeStore.setConnection('error', wsEndpoint));

            // Register every message handler right after joining: the server sends history,
            // tasks and layout from onJoin, and anything without a handler is dropped.
            room.onMessage('chat', (message: any) => officeStore.addChat(message));
            room.onMessage('chat-history', (messages: any) => officeStore.setChat(Array.isArray(messages) ? messages : []));
            room.onMessage('tasks-sync', (rows: any) => officeStore.setTasks(tasksFromRows(rows)));
            room.onMessage('task-update', (task: any) => officeStore.upsertTask({
                id: Number(task.id),
                title: String(task.title || ''),
                agentId: String(task.agentId || ''),
                status: task.status,
                summary: task.summary
            }));
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
                    let sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Rectangle;
                    if (this.textures.exists(charKey)) {
                        sprite = this.add.sprite(0, -8, charKey, 0);
                        const tint = SPRITE_TINTS[Math.floor(spriteIndex / CHARACTER_SHEETS) % SPRITE_TINTS.length];
                        if (tint !== 0xffffff) sprite.setTint(tint);
                    } else {
                        sprite = this.add.rectangle(0, -8, 16, 32, 0x3a86ff);
                    }

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

                    container.add([focusRing, sprite, thoughtBubble, emoteBubble, label]);
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
                        sprite: spriteIndex
                    });
                    publish();
                    let lastThought = agent.thought || '';

                    let prevX = agent.x;
                    let prevY = agent.y;
                    let lastAction = '';

                    agent.onChange(() => {
                        this.tweens.add({
                            targets: container,
                            x: agent.x * 16,
                            y: agent.y * 16,
                            duration: 100,
                            onComplete: () => {
                                if (sprite.type === 'Sprite') {
                                    (sprite as Phaser.GameObjects.Sprite).stop();
                                }
                            }
                        });

                        // Walk animation
                        if (sprite.type === 'Sprite') {
                            const s = sprite as Phaser.GameObjects.Sprite;
                            if (agent.x > prevX) { s.play(`${charKey}-walk-right`, true); s.setFlipX(false); }
                            else if (agent.x < prevX) { s.play(`${charKey}-walk-right`, true); s.setFlipX(true); }
                            else if (agent.y > prevY) { s.play(`${charKey}-walk-down`, true); }
                            else if (agent.y < prevY) { s.play(`${charKey}-walk-up`, true); }
                            else { s.stop(); }
                        }

                        // --- EMOTE BUBBLES based on action ---
                        const emoteMap: Record<string, string> = {
                            'work': '💻', 'talk': '💬', 'idle': '😌',
                            'use_tool': '🔧', 'move': '🚶', 'think': '💡'
                        };
                        const emote = emoteMap[agent.action] || '';
                        if (emote && agent.action !== lastAction) {
                            emoteBubble.setText(emote);
                            emoteBubble.setVisible(true);
                            // Auto-hide after 3s
                            this.time.delayedCall(3000, () => emoteBubble.setVisible(false));
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
                    officeStore.removeAgent(sessionId);
                });
            });

        } catch (e) {
            console.error(e);
            officeStore.setConnection('error', wsEndpoint);
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

    update() {
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
