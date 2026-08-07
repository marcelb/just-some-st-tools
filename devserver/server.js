/**
 * Local test harness. Serves a small page that lists every registered tool and
 * lets you invoke it against an in-memory mock of SillyTavern's chat metadata.
 *
 * Run with: npm run dev
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as mock from './mock-sillytavern.js';

mock.install();

const { PREFIX, TOOLS, safeAction } = await import('../lib/registry.js');
const { NAMESPACE } = await import('../lib/state.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;

const byName = new Map(TOOLS.map(tool => [tool.name, tool]));
const runners = new Map(TOOLS.map(tool => [tool.name, safeAction(tool)]));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, 'public')));

app.get('/api/tools', (req, res) => {
    res.json({
        prefix: PREFIX,
        namespace: NAMESPACE,
        tools: TOOLS.map(tool => ({
            name: tool.name,
            registeredName: `${PREFIX}${tool.name}`,
            displayName: tool.displayName,
            description: tool.description,
            parameters: tool.parameters,
            stateKeys: tool.stateKeys ?? [],
            actionFields: tool.actionFields ?? null,
        })),
    });
});

app.post('/api/run/:name', async (req, res) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
        return res.status(404).json({ error: `No tool named "${req.params.name}".` });
    }

    const args = req.body?.args ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) {
        return res.status(400).json({ error: 'args must be a JSON object.' });
    }

    const started = Date.now();
    try {
        const result = await runners.get(tool.name)(args);
        res.json({
            tool: tool.name,
            chatId: mock.getCurrentChatId(),
            ms: Date.now() - started,
            result: String(result ?? ''),
        });
    } catch (error) {
        // safeAction should swallow everything; reaching here is itself a finding.
        res.status(500).json({
            error: `Escaped safeAction: ${error?.stack ?? error}`,
            ms: Date.now() - started,
        });
    }
});

app.get('/api/chats', (req, res) => {
    res.json({
        chats: mock.listChats(),
        current: mock.getCurrentChatId(),
        saves: mock.getSaveCount(),
    });
});

app.post('/api/chats/switch', (req, res) => {
    try {
        const id = mock.switchChat(req.body?.id);
        res.json({ current: id, chats: mock.listChats() });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/chats/reset', (req, res) => {
    mock.resetChat();
    res.json({ current: mock.getCurrentChatId(), state: mock.getMetadata() });
});

app.get('/api/state', (req, res) => {
    res.json({
        chatId: mock.getCurrentChatId(),
        saves: mock.getSaveCount(),
        metadata: mock.getMetadata(),
    });
});

/**
 * actionFields is hand-maintained, so check it against the schema at boot
 * rather than letting the form quietly hide a parameter that still exists.
 */
function auditActionFields() {
    for (const tool of TOOLS) {
        if (!tool.actionFields) continue;

        const props = Object.keys(tool.parameters?.properties ?? {}).filter(p => p !== 'action');
        const actions = tool.parameters?.properties?.action?.enum ?? [];
        const mapped = new Set(Object.values(tool.actionFields).flat());

        for (const action of actions) {
            if (!(action in tool.actionFields)) {
                console.warn(`[audit] ${tool.name}: action "${action}" has no actionFields entry`);
            }
        }
        for (const action of Object.keys(tool.actionFields)) {
            if (!actions.includes(action)) {
                console.warn(`[audit] ${tool.name}: actionFields lists unknown action "${action}"`);
            }
            for (const field of tool.actionFields[action]) {
                if (!props.includes(field)) {
                    console.warn(`[audit] ${tool.name}.${action}: no such parameter "${field}"`);
                }
            }
        }
        for (const prop of props) {
            if (!mapped.has(prop)) {
                console.warn(`[audit] ${tool.name}: parameter "${prop}" belongs to no action`);
            }
        }
    }
}

auditActionFields();

app.listen(PORT, () => {
    console.log(`Tool harness on http://localhost:${PORT} — ${TOOLS.length} tools, chat "${mock.getCurrentChatId()}"`);
});
