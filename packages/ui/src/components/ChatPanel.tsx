import React, { useState, useEffect, useRef } from 'react';
import { getColyseusRoom } from '../game/Game';
import { Panel } from './Panel';
import { useOffice, officeStore, agentColor } from '../store';

const SYSTEM_SENDERS = ['System', '🏢 Office', '🎬 Producer', '⚠️ Chaos Engine'];

function senderColor(sender: string): string {
    if (sender === 'User') return '#ffd166';
    if (SYSTEM_SENDERS.includes(sender)) return '#00eeff';
    return agentColor(sender);
}

export function ChatPanel() {
    const messages = useOffice(s => s.chat);
    const agents = useOffice(s => s.agents);
    const [input, setInput] = useState('');
    const logRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const log = logRef.current;
        if (log) log.scrollTop = log.scrollHeight;
    }, [messages]);

    const send = () => {
        const text = input.trim();
        if (!text) return;
        const room = getColyseusRoom();
        if (room) {
            room.send('chat', { text });
            setInput('');
        } else {
            officeStore.addChat({ sender: 'System', text: 'Cannot send: not connected to the office server.' });
        }
    };

    const mention = (name: string) => setInput(value => `${value}${value && !value.endsWith(' ') ? ' ' : ''}@${name} `);

    return (
        <Panel id="office-chat" title="💬 Office Chat" subtitle="Mention @Name to talk to someone, @all for everyone">
            <div ref={logRef} className="chat-log" role="log" aria-live="polite">
                {messages.length === 0 && <p className="empty">No messages yet.</p>}
                {messages.map((m, i) => (
                    <p key={i} className={m.text.includes('(to User)') ? 'to-user' : undefined}>
                        <strong style={{ color: senderColor(m.sender) }}>{m.sender}:</strong> {m.text}
                    </p>
                ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                {agents.map(a => (
                    <button key={a.id} type="button" className="btn btn-small" onClick={() => mention(a.name)}
                        style={{ padding: '2px 7px', color: agentColor(a.name) }} title={`Mention ${a.name} (${a.role})`}>
                        @{a.name}
                    </button>
                ))}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: 'flex', gap: 6 }}>
                <input
                    type="text"
                    name="chat-message"
                    className="field"
                    aria-label="Message the office"
                    placeholder="Message the team..."
                    maxLength={500}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                />
                <button type="submit" className="btn btn-primary" disabled={!input.trim()}>Send</button>
            </form>
        </Panel>
    );
}
