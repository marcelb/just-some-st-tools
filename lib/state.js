import { ToolError } from './errors.js';

export const NAMESPACE = 'justSomeStTools';
const SCHEMA_VERSION = 1;

export function context() {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        throw new ToolError('SillyTavern context is unavailable.');
    }
    return SillyTavern.getContext();
}

function emptyState() {
    return {
        version: SCHEMA_VERSION,
        combat: { active: false, combatants: [] },
        notes: {},
        tables: {},
        clock: null,
    };
}

function metadata() {
    const ctx = context();
    const md = ctx.chatMetadata ?? ctx.chat_metadata;
    if (!md || typeof md !== 'object') {
        throw new ToolError('No active chat. Open or start a chat before using these tools.');
    }
    return md;
}

export function getState() {
    const md = metadata();
    if (!md[NAMESPACE]) {
        md[NAMESPACE] = emptyState();
    }
    return migrate(md[NAMESPACE]);
}

function migrate(state) {
    const base = emptyState();
    for (const [key, value] of Object.entries(base)) {
        if (state[key] === undefined || state[key] === null) {
            if (key !== 'clock') {
                state[key] = value;
            }
        }
    }
    state.version = SCHEMA_VERSION;
    return state;
}

export async function save() {
    const ctx = context();
    const saver = ctx.saveMetadata ?? ctx.saveMetadataDebounced;
    if (typeof saver !== 'function') {
        throw new ToolError('This SillyTavern build exposes no way to save chat metadata.');
    }
    await saver.call(ctx);
}

export function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

export async function transaction(readOnly, fn) {
    const state = getState();
    if (readOnly) {
        return fn(state);
    }
    const working = clone(state);
    const result = await fn(working);
    for (const key of Object.keys(working)) {
        state[key] = working[key];
    }
    await save();
    return result;
}

export function normalizeKey(name) {
    if (typeof name !== 'string' || !name.trim()) {
        throw new ToolError('Expected a non-empty name.');
    }
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
