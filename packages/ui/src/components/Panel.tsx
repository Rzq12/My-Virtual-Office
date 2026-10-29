import React, { useEffect, useState } from 'react';

interface PanelProps {
    id: string;
    title: string;
    subtitle?: string;
    defaultCollapsed?: boolean;
    /** Extra controls rendered on the right side of the header. */
    headerExtra?: React.ReactNode;
    onCollapsedChange?: (collapsed: boolean) => void;
    children: React.ReactNode;
}

function readCollapsed(id: string, fallback: boolean): boolean {
    try {
        const raw = window.localStorage.getItem(`panel:${id}:collapsed`);
        return raw === null ? fallback : raw === '1';
    } catch {
        return fallback;
    }
}

/** A collapsible card that lives in one of the sidebars; its open/closed state is remembered per browser. */
export function Panel({ id, title, subtitle, defaultCollapsed = false, headerExtra, onCollapsedChange, children }: PanelProps) {
    const [collapsed, setCollapsed] = useState(() => readCollapsed(id, defaultCollapsed));
    const bodyId = `panel-${id}-body`;

    useEffect(() => {
        try {
            window.localStorage.setItem(`panel:${id}:collapsed`, collapsed ? '1' : '0');
        } catch {
            // Storage can be unavailable (private mode); the panel still works.
        }
        onCollapsedChange?.(collapsed);
    }, [collapsed, id, onCollapsedChange]);

    return (
        <section className={`panel${collapsed ? '' : ' expanded'}`} aria-label={title}>
            <div className="panel-header">
                <button
                    type="button"
                    className="panel-toggle"
                    aria-expanded={!collapsed}
                    aria-controls={bodyId}
                    onClick={() => setCollapsed(value => !value)}
                >
                    <span className="panel-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                    <span>
                        <span className="panel-title">{title}</span>
                        {subtitle && <span className="panel-subtitle">{subtitle}</span>}
                    </span>
                </button>
                {headerExtra && <div className="panel-extra">{headerExtra}</div>}
            </div>
            {!collapsed && (
                <div id={bodyId} className="panel-body">
                    {children}
                </div>
            )}
        </section>
    );
}
