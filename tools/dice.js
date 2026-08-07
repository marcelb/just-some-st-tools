import { roll, applyAdvantage } from '../lib/dice.js';
import { asBatch } from '../lib/errors.js';

export default {
    name: 'roll_dice',
    displayName: 'Roll Dice',
    stateKeys: [],
    description: 'Roll dice. Pass every roll you need in one call, attack and damage together, or one entry per combatant — rather than calling repeatedly. Notation supports 4d6kh3 (keep highest 3), 2d20kl1 (keep lowest one), 1d10! (max rolls roll again), 4d6r1 (reroll 1s), 1d% (1d100) and multi-term sums like 2d6+1d4-2.',
    parameters: {
        type: 'object',
        properties: {
            rolls: {
                type: 'array',
                minItems: 1,
                description: 'All rolls to make.',
                items: {
                    type: 'object',
                    properties: {
                        notation: { type: 'string', description: 'Dice notation, e.g. "1d20+5".' },
                        label: { type: 'string', description: 'What it is for, e.g. "Goblin 2 attack".' },
                        advantage: {
                            type: 'string',
                            enum: ['none', 'advantage', 'disadvantage'],
                            description: 'd20 tests only. Rolls the d20 twice, keeping best or worst; bonus dice roll once. Errors unless the notation is a single plain d20.',
                        },
                        dc: { type: 'integer', description: 'Target number. Reports SUCCESS or FAIL against it.' },
                    },
                    required: ['notation'],
                },
            },
        },
        required: ['rolls'],
    },
    action: async ({ rolls }) => {
        const batch = asBatch(rolls, 'rolls');
        const lines = batch.map((entry, index) => {
            const label = entry.label || `Roll ${index + 1}`;
            let notation = entry.notation;
            let result;

            try {
                notation = applyAdvantage(notation, entry.advantage);
                result = roll(notation);
            } catch (error) {
                return `${label}: ERROR — ${error.message}`;
            }

            // Verdict sits next to the total so it reads before the dice detail.
            const verdict = Number.isInteger(entry.dc)
                ? ` — ${result.total >= entry.dc ? 'SUCCESS' : 'FAIL'} vs DC ${entry.dc}`
                : '';
            return `${label}: **${result.total}**${verdict} (${notation} → ${result.breakdown})`;
        });

        return lines.join('\n');
    },
};
