import { ToolError } from './errors.js';

import dice from '../tools/dice.js';
import combat from '../tools/combat.js';
import notes from '../tools/notes.js';
import tables from '../tools/tables.js';
import time from '../tools/time.js';

export const MODULE_NAME = 'just-some-st-tools';

export const PREFIX = 'rpg_';

export const TOOLS = [dice, combat, notes, tables, time].flat();

export function safeAction(tool) {
    return async (args) => {
        try {
            return await tool.action(args ?? {});
        } catch (error) {
            if (error instanceof ToolError) {
                return `Error: ${error.message}`;
            }
            console.error(`[${MODULE_NAME}] ${tool.name} threw:`, error);
            return `Error: ${tool.name} failed unexpectedly (${error?.message ?? error}). This is a bug in ${MODULE_NAME}.`;
        }
    };
}
