import { mergeTask, tasksFromRows, agentColor, officeStore, getSnapshot, TaskInfo } from '../store';

describe('store helpers', () => {
    it('tasksFromRows maps server rows and normalises unknown status', () => {
        const rows = [
            { id: 3, title: 'Deploy', assigned_to: 'dimas', status: 'in_progress' },
            { id: '4', title: 'Old', assigned_to: null, status: 'weird' }
        ];
        expect(tasksFromRows(rows)).toEqual([
            { id: 3, title: 'Deploy', agentId: 'dimas', status: 'in_progress' },
            { id: 4, title: 'Old', agentId: '', status: 'pending' }
        ]);
        expect(tasksFromRows(null)).toEqual([]);
    });

    it('mergeTask updates by id and prepends new tasks', () => {
        const tasks: TaskInfo[] = [{ id: 1, title: 'A', agentId: 'alice', status: 'in_progress' }];
        const updated = mergeTask(tasks, { id: 1, title: 'A', agentId: 'alice', status: 'completed', summary: 'done' });
        expect(updated).toHaveLength(1);
        expect(updated[0].status).toBe('completed');

        const added = mergeTask(updated, { id: 2, title: 'B', agentId: 'bob', status: 'pending' });
        expect(added.map(t => t.id)).toEqual([2, 1]);
    });

    it('agentColor is stable and case-insensitive', () => {
        expect(agentColor('Citra')).toBe(agentColor('citra'));
        expect(agentColor('Citra')).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('keeps tasks that arrive before any component subscribes', () => {
        officeStore.setTasks([{ id: 9, title: 'Early', agentId: 'alice', status: 'pending' }]);
        expect(getSnapshot().tasks[0].title).toBe('Early');
    });

    it('caps the chat history', () => {
        officeStore.setChat([]);
        for (let i = 0; i < 250; i++) officeStore.addChat({ sender: 'System', text: String(i) });
        const chat = getSnapshot().chat;
        expect(chat).toHaveLength(200);
        expect(chat[chat.length - 1].text).toBe('249');
    });
});
