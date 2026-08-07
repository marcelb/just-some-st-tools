import { transaction, normalizeKey } from '../lib/state.js';
import { ToolError, asBatch } from '../lib/errors.js';

const READ_ONLY = new Set(['read', 'list']);

export default {
    name: 'notes',
    displayName: 'Scratchpad Notes',
    stateKeys: ['notes'],
    actionFields: {
        write: ['notes'],
        append: ['notes'],
        read: ['keys'],
        list: [],
        delete: ['keys'],
        clear: [],
    },
    description: 'Keyed notes for this chat, for anything worth remembering later — scene state like "trap_state" as well as campaign canon like "npc_willa" or "quest_caravan". There is no search: call list first to see which keys exist, then read the ones you need. Do that before inventing a detail that may already be established.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['write', 'append', 'read', 'list', 'delete', 'clear'],
                description: 'write replaces, append adds a line, read returns notes by key, list returns all keys.',
            },
            notes: {
                type: 'array',
                description: 'For write/append.',
                items: {
                    type: 'object',
                    properties: {
                        key: { type: 'string', description: 'Short id, e.g. "tavern_patrons".' },
                        text: { type: 'string' },
                    },
                    required: ['key', 'text'],
                },
            },
            keys: {
                type: 'array',
                items: { type: 'string' },
                description: 'For read/delete. Omit on read for all notes.',
            },
        },
        required: ['action'],
    },
    action: async (args) => transaction(READ_ONLY.has(args.action), (state) => {
        const store = state.notes;

        switch (args.action) {
            case 'write':
            case 'append': {
                const batch = asBatch(args.notes, 'notes');
                const touched = [];
                for (const note of batch) {
                    if (typeof note?.key !== 'string' || !note.key.trim()) {
                        throw new ToolError('Every note needs a "key".');
                    }
                    if (typeof note.text !== 'string' || !note.text.trim()) {
                        throw new ToolError(`Note "${note.key}" needs non-empty "text".`);
                    }
                    const key = normalizeKey(note.key);
                    const existing = store[key];
                    const label = args.action === 'append' && existing ? existing.key : note.key.trim();
                    store[key] = {
                        key: label,
                        text: args.action === 'append' && existing
                            ? `${existing.text}\n${note.text.trim()}`
                            : note.text.trim(),
                    };
                    touched.push(note.key.trim());
                }
                return `Saved ${touched.length} note(s): ${touched.join(', ')}.`;
            }

            case 'read': {
                const entries = Object.values(store);
                if (!args.keys || args.keys.length === 0) {
                    return entries.length
                        ? entries.map(n => `### ${n.key}\n${n.text}`).join('\n\n')
                        : 'No notes in this chat.';
                }
                const out = [];
                for (const raw of asBatch(args.keys, 'keys')) {
                    const note = store[normalizeKey(raw)];
                    out.push(note ? `### ${note.key}\n${note.text}` : `### ${raw}\n(not found)`);
                }
                return out.join('\n\n');
            }

            case 'list': {
                const keys = Object.values(store).map(n => n.key);
                return keys.length ? `Notes: ${keys.join(', ')}` : 'No notes in this chat.';
            }

            case 'delete': {
                const keys = asBatch(args.keys, 'keys');
                const removed = [];
                for (const raw of keys) {
                    const key = normalizeKey(raw);
                    if (!store[key]) {
                        throw new ToolError(`No note with key "${raw}".`);
                    }
                    removed.push(store[key].key);
                    delete store[key];
                }
                return `Deleted: ${removed.join(', ')}.`;
            }

            case 'clear': {
                const count = Object.keys(store).length;
                state.notes = {};
                return `Cleared ${count} note(s).`;
            }

            default:
                throw new ToolError(`Unknown action "${args.action}".`);
        }
    }),
};
