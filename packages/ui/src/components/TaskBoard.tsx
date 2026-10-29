import React, { useMemo, useState } from 'react';
import { getColyseusRoom } from '../game/Game';
import { Panel } from './Panel';
import { useOffice, TaskStatus } from '../store';

const STATUS_ORDER: Record<TaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 };

const statusColor = (s: TaskStatus) => {
    if (s === 'completed') return '#00b894';
    if (s === 'in_progress') return '#fdcb6e';
    return '#b2bec3';
};

const statusLabel = (s: TaskStatus) => {
    if (s === 'completed') return '✅ Done';
    if (s === 'in_progress') return '🔄 In progress';
    return '⏳ Queued';
};

export function TaskBoard() {
    const tasks = useOffice(s => s.tasks);
    const agents = useOffice(s => s.agents);
    const [newTask, setNewTask] = useState('');
    const [targetAgent, setTargetAgent] = useState('auto');
    const [showDone, setShowDone] = useState(false);

    const names = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a.name])), [agents]);
    const sorted = useMemo(
        () => [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.id - a.id),
        [tasks]
    );
    const doneCount = tasks.filter(t => t.status === 'completed').length;
    const visible = showDone ? sorted : sorted.filter(t => t.status !== 'completed');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const title = newTask.trim();
        if (!title) return;
        const room = getColyseusRoom();
        if (room) {
            room.send('assign-task', { title, agentId: targetAgent === 'auto' ? undefined : targetAgent });
            setNewTask('');
        }
    };

    return (
        <Panel id="task-board" title="📋 Task Board" subtitle={`${tasks.length - doneCount} open · ${doneCount} done`}>
            <form onSubmit={handleSubmit} style={{ marginBottom: 10 }}>
                <input
                    type="text"
                    name="task-title"
                    className="field"
                    aria-label="Task title"
                    placeholder="Describe a task..."
                    maxLength={200}
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    style={{ marginBottom: 6 }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                    <select
                        name="task-assignee"
                        className="field"
                        aria-label="Assign to"
                        value={targetAgent}
                        onChange={(e) => setTargetAgent(e.target.value)}
                        style={{ flex: 1, minWidth: 0 }}
                    >
                        <option value="auto">🤖 Auto-assign (best role match)</option>
                        {agents.map(a => (
                            <option key={a.id} value={a.id}>{a.name} — {a.role}</option>
                        ))}
                    </select>
                    <button type="submit" className="btn btn-primary" disabled={!newTask.trim()}>Assign</button>
                </div>
            </form>

            <div className="scroll-list" style={{ fontSize: 12 }}>
                {visible.length === 0 && (
                    <p className="empty">{tasks.length === 0 ? 'No tasks yet. Describe one above to put the team to work.' : 'No open tasks.'}</p>
                )}
                {visible.map(task => (
                    <div key={task.id} style={{
                        padding: '6px 8px', marginBottom: 4, borderRadius: 6,
                        backgroundColor: 'rgba(255,255,255,0.05)',
                        borderLeft: `3px solid ${statusColor(task.status)}`
                    }}>
                        <div style={{ fontWeight: 700, fontSize: 11 }}>{task.title}</div>
                        <div style={{ fontSize: 10, color: '#9a9fc8', marginTop: 2, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                            <span>→ {names[task.agentId] || task.agentId || 'Unassigned'}</span>
                            <span>{statusLabel(task.status)}</span>
                        </div>
                        {task.summary && <div style={{ fontSize: 10, color: '#cfe9df', marginTop: 3 }}>{task.summary}</div>}
                    </div>
                ))}
            </div>
            {doneCount > 0 && (
                <button type="button" className="btn btn-small" style={{ marginTop: 6 }} onClick={() => setShowDone(v => !v)}>
                    {showDone ? 'Hide completed' : `Show ${doneCount} completed`}
                </button>
            )}
        </Panel>
    );
}
