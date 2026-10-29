import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolExecutor } from '../tools/ToolExecutor';

describe('ToolExecutor', () => {
    let workspace: string;
    let tools: ToolExecutor;

    beforeEach(() => {
        workspace = mkdtempSync(join(tmpdir(), 'agent-office-ws-'));
        tools = new ToolExecutor(workspace);
    });

    afterEach(() => {
        rmSync(workspace, { recursive: true, force: true });
    });

    describe('code_execute', () => {
        it('returns the value of the snippet', async () => {
            const result = await tools.execute('code_execute', { code: 'return [1, 2, 3].map(n => n * 2);' });
            expect(result).toEqual({ success: true, output: '[2,4,6]' });
        });

        it('blocks file system and child process access', async () => {
            const fsResult = await tools.execute('code_execute', { code: `return require('fs').readdirSync('.');` });
            expect(fsResult.success).toBe(false);
            expect(fsResult.error).toMatch(/restricted|denied/i);

            const cpResult = await tools.execute('code_execute', { code: `return require('child_process').execSync('echo hi').toString();` });
            expect(cpResult.success).toBe(false);
        });

        it('does not pass the server environment to the snippet', async () => {
            process.env.AGENT_OFFICE_TEST_SECRET = 'top-secret';
            const result = await tools.execute('code_execute', { code: 'return process.env.AGENT_OFFICE_TEST_SECRET || "none";' });
            delete process.env.AGENT_OFFICE_TEST_SECRET;
            expect(result.output).toBe('none');
        });

        it('cannot break out through shell quoting', async () => {
            const result = await tools.execute('code_execute', { code: 'return "a\\" && echo injected && \\"b";' });
            expect(result.success).toBe(true);
            expect(result.output).toBe('a" && echo injected && "b');
        });

        it('kills runaway code', async () => {
            const result = await tools.execute('code_execute', { code: 'while (true) {}' });
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/Timed out/);
        }, 15000);

        it('rejects other languages', async () => {
            const result = await tools.execute('code_execute', { code: 'print(1)', language: 'python' });
            expect(result.success).toBe(false);
        });
    });

    describe('read_file', () => {
        it('reads files inside the workspace', async () => {
            writeFileSync(join(workspace, 'hello.txt'), 'hi there');
            expect(await tools.execute('read_file', { path: 'hello.txt' })).toEqual({ success: true, output: 'hi there' });
        });

        it.each([
            '../outside.txt',
            'notes/../../outside.txt',
            '/etc/passwd',
            'C:\\Windows\\win.ini',
            ''
        ])('refuses %p', async (path) => {
            const result = await tools.execute('read_file', { path });
            expect(result.success).toBe(false);
        });
    });

    it('lists the real files when a path does not exist', async () => {
        await tools.execute('write_note', { content: 'plan' }, { agentName: 'Dimas' });
        const result = await tools.execute('read_file', { path: 'README.md' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('notes/dimas.md');
    });

    it('write_note appends to the agent notes file', async () => {
        await tools.execute('write_note', { content: 'first' }, { agentName: 'Citra' });
        await tools.execute('write_note', { content: 'second' }, { agentName: 'Citra' });
        const text = readFileSync(join(workspace, 'notes', 'citra.md'), 'utf-8');
        expect(text).toContain('first');
        expect(text).toContain('second');
    });
});
