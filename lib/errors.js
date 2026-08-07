export class ToolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolError';
    }
}

export function asBatch(value, label) {
    if (value === undefined || value === null) {
        throw new ToolError(`Missing "${label}".`);
    }
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) {
        throw new ToolError(`"${label}" must contain at least one entry.`);
    }
    return list;
}
