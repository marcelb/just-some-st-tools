import { transaction, normalizeKey } from '../lib/state.js';
import { ToolError, asBatch } from '../lib/errors.js';

const READ_ONLY = new Set(['roll', 'list', 'show']);

function pick(entries) {
    const total = entries.reduce((sum, e) => sum + e.weight, 0);
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    let target = (buffer[0] / 0x100000000) * total;
    for (const entry of entries) {
        target -= entry.weight;
        if (target < 0) return entry;
    }
    return entries[entries.length - 1];
}

export default {
    name: 'random_table',
    displayName: 'Random Table',
    stateKeys: ['tables'],
    actionFields: {
        define: ['tables'],
        roll: ['rolls'],
        list: [],
        show: ['names'],
        delete: ['names'],
    },
    description: 'Weighted random tables (loot, encounters, rumours, names), stored per chat. Roll several times or from several tables in one call.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['define', 'roll', 'list', 'show', 'delete'],
                description: 'define fails if the name is taken; delete first to replace. roll draws; show prints entries.',
            },
            tables: {
                type: 'array',
                description: 'For define.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        entries: {
                            type: 'array',
                            minItems: 1,
                            items: {
                                type: 'object',
                                properties: {
                                    result: { type: 'string' },
                                    weight: { type: 'number', description: 'Relative likelihood, default 1.' },
                                },
                                required: ['result'],
                            },
                        },
                    },
                    required: ['name', 'entries'],
                },
            },
            rolls: {
                type: 'array',
                description: 'For roll.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Table to roll on.' },
                        count: { type: 'integer', description: 'Draws, default 1.' },
                        unique: { type: 'boolean', description: 'Draw without replacement.' },
                    },
                    required: ['name'],
                },
            },
            names: { type: 'array', items: { type: 'string' }, description: 'For show/delete.' },
        },
        required: ['action'],
    },
    action: async (args) => transaction(READ_ONLY.has(args.action), (state) => {
        const store = state.tables;

        const lookup = (name) => {
            const table = store[normalizeKey(name)];
            if (!table) {
                const known = Object.values(store).map(t => t.name).join(', ') || 'none defined';
                throw new ToolError(`No table named "${name}". Available: ${known}.`);
            }
            return table;
        };

        switch (args.action) {
            case 'define': {
                const batch = asBatch(args.tables, 'tables');
                const defined = [];
                for (const table of batch) {
                    if (typeof table?.name !== 'string' || !table.name.trim()) {
                        throw new ToolError('Every table needs a "name".');
                    }
                    const entries = asBatch(table.entries, `entries for "${table.name}"`).map(entry => {
                        if (typeof entry?.result !== 'string' || !entry.result.trim()) {
                            throw new ToolError(`Every entry in "${table.name}" needs a "result".`);
                        }
                        const weight = entry.weight === undefined ? 1 : Number(entry.weight);
                        if (!Number.isFinite(weight) || weight <= 0) {
                            throw new ToolError(`Weight for "${entry.result}" must be a positive number.`);
                        }
                        return { result: entry.result.trim(), weight };
                    });
                    const key = normalizeKey(table.name);
                    if (store[key]) {
                        throw new ToolError(`"${store[key].name}" already exists with ${store[key].entries.length} entries. Delete it first if you mean to replace it.`);
                    }
                    store[key] = { name: table.name.trim(), entries };
                    defined.push(`${table.name.trim()} (${entries.length} entries)`);
                }
                return `Defined: ${defined.join(', ')}.`;
            }

            case 'roll': {
                const batch = asBatch(args.rolls, 'rolls');
                const output = [];
                for (const request of batch) {
                    const table = lookup(request.name);
                    const count = request.count === undefined || request.count === null ? 1 : request.count;
                    if (!Number.isInteger(count) || count < 1 || count > 100) {
                        throw new ToolError(`"count" for "${request.name}" must be a whole number between 1 and 100, got ${JSON.stringify(request.count)}.`);
                    }
                    if (request.unique && count > table.entries.length) {
                        throw new ToolError(`"${table.name}" has only ${table.entries.length} entries; cannot draw ${count} unique results.`);
                    }

                    const pool = [...table.entries];
                    const drawn = [];
                    for (let i = 0; i < count; i++) {
                        const entry = pick(pool);
                        drawn.push(entry.result);
                        if (request.unique) {
                            pool.splice(pool.indexOf(entry), 1);
                        }
                    }
                    output.push(count === 1
                        ? `${table.name}: ${drawn[0]}`
                        : `${table.name}:\n${drawn.map(r => `  - ${r}`).join('\n')}`);
                }
                return output.join('\n');
            }

            case 'list': {
                const tables = Object.values(store);
                return tables.length
                    ? tables.map(t => `${t.name} (${t.entries.length} entries)`).join('\n')
                    : 'No tables defined in this chat.';
            }

            case 'show': {
                const names = asBatch(args.names, 'names');
                return names.map(name => {
                    const table = lookup(name);
                    const rows = table.entries.map(e => `  - ${e.result}${e.weight !== 1 ? ` (weight ${e.weight})` : ''}`);
                    return `### ${table.name}\n${rows.join('\n')}`;
                }).join('\n\n');
            }

            case 'delete': {
                const names = asBatch(args.names, 'names');
                const removed = names.map(name => {
                    const table = lookup(name);
                    delete store[normalizeKey(name)];
                    return table.name;
                });
                return `Deleted: ${removed.join(', ')}.`;
            }

            default:
                throw new ToolError(`Unknown action "${args.action}".`);
        }
    }),
};
