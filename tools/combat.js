import { transaction, normalizeKey } from '../lib/state.js';
import { ToolError, asBatch } from '../lib/errors.js';
import { roll } from '../lib/dice.js';

function find(track, name) {
    const key = normalizeKey(name);
    const found = track.combatants.find(c => normalizeKey(c.name) === key);
    if (!found) {
        const known = track.combatants.map(c => c.name).join(', ') || 'none';
        throw new ToolError(`No combatant named "${name}". In the encounter: ${known}.`);
    }
    return found;
}

function order(track) {
    track.combatants.sort((a, b) =>
        b.initiative - a.initiative ||
        (b.initiativeModifier ?? 0) - (a.initiativeModifier ?? 0) ||
        a.name.localeCompare(b.name));
}

function isDead(c) {
    if (c.hp > 0) {
        return false;
    }
    return !c.isPC || (c.deathSaves?.failures ?? 0) >= 3;
}

function status(c) {
    if (c.hp > 0) {
        return '';
    }
    if (isDead(c)) {
        return ' [DEAD]';
    }
    const saves = c.deathSaves ?? { successes: 0, failures: 0 };
    if (saves.successes >= 3) {
        return ' [DOWN, stable]';
    }
    return ` [DOWN, death saves ${saves.successes}/3 passed, ${saves.failures}/3 failed]`;
}

function positiveAmount(value, name, field) {
    const amount = Math.round(Number(value));
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new ToolError(`"${field}" for ${name} must be a positive number.`);
    }
    return amount;
}

function render(track) {
    if (!track.active || track.combatants.length === 0) {
        return 'No encounter is running.';
    }
    const lines = track.combatants.map(c =>
        `${c.initiative.toString().padStart(2)} — ${c.name} (${c.hp}/${c.maxHp} HP)${status(c)}`);
    return `Initiative order:\n${lines.join('\n')}`;
}

const handlers = {
    add(track, args) {
        const combatants = asBatch(args.combatants, 'combatants');
        const added = [];

        for (const entry of combatants) {
            if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) {
                throw new ToolError('Every combatant needs a name.');
            }
            const key = normalizeKey(entry.name);
            if (track.combatants.some(c => normalizeKey(c.name) === key)) {
                throw new ToolError(`"${entry.name}" is already in the encounter. Use unique names like "Goblin 1", "Goblin 2".`);
            }

            // maxHp anchors every later clamp, so it is required rather than guessed.
            const maxHp = Math.round(Number(entry.maxHp));
            if (!Number.isFinite(maxHp) || maxHp < 1) {
                throw new ToolError(`"maxHp" for ${entry.name} is required and must be at least 1.`);
            }
            const hp = entry.hp === undefined || entry.hp === null ? maxHp : Math.round(Number(entry.hp));
            if (!Number.isFinite(hp) || hp < 0 || hp > maxHp) {
                throw new ToolError(`"hp" for ${entry.name} must be between 0 and ${maxHp}. Leave it out to start at full health.`);
            }

            const modifier = Number.isFinite(entry.initiativeModifier) ? entry.initiativeModifier : 0;
            const initiative = roll(`1d20${modifier >= 0 ? '+' : ''}${modifier}`).total;

            track.combatants.push({
                name: entry.name.trim(),
                initiative,
                hp,
                maxHp,
                initiativeModifier: modifier,
                isPC: entry.isPC === true,
                deathSaves: hp === 0 && entry.isPC === true ? { successes: 0, failures: 0 } : null,
            });
            added.push(`${entry.name} (init ${initiative})`);
        }

        order(track);
        track.active = true;
        return `Added: ${added.join(', ')}.\n${render(track)}`;
    },

    remove(track, args) {
        const names = asBatch(args.names, 'names');

        for (const name of names) {
            const target = find(track, name);
            track.combatants.splice(track.combatants.indexOf(target), 1);
        }
        if (track.combatants.length === 0) {
            track.active = false;
            return 'Last combatant removed; encounter over.';
        }
        return `Removed: ${names.join(', ')}.\n${render(track)}`;
    },

    damage(track, args) {
        const changes = asBatch(args.damage, 'damage');
        const lines = [];
        for (const change of changes) {
            const target = find(track, change.name);
            const amount = positiveAmount(change.amount, change.name, 'amount');
            if (isDead(target)) {
                throw new ToolError(`${target.name} is already dead.`);
            }

            if (target.hp === 0) {
                const failures = change.crit === true ? 2 : 1;
                const wasStable = (target.deathSaves?.successes ?? 0) >= 3;
                if (wasStable || !target.deathSaves) {
                    target.deathSaves = { successes: 0, failures: 0 };
                }
                target.deathSaves.failures += failures;
                const how = failures === 2 ? 'critically hit' : 'hit';
                const again = wasStable ? ' and is no longer stable' : '';
                lines.push(`${target.name} is ${how} while down${again}: ${failures} automatic death save failure(s).${status(target)}`);
                continue;
            }

            const before = target.hp;
            target.hp = Math.max(0, target.hp - amount);
            if (target.hp === 0 && target.isPC) {
                target.deathSaves = { successes: 0, failures: 0 };
            }
            lines.push(`${target.name} takes ${amount}: ${before} → ${target.hp} HP${status(target)}`);
        }
        return `${lines.join('\n')}\n\n${render(track)}`;
    },

    heal(track, args) {
        const changes = asBatch(args.heal, 'heal');
        const lines = [];
        for (const change of changes) {
            const target = find(track, change.name);
            const amount = positiveAmount(change.amount, change.name, 'amount');
            if (isDead(target)) {
                throw new ToolError(`${target.name} is dead; healing does nothing. Use "revive" for magic that raises the dead.`);
            }

            const before = target.hp;
            target.hp = Math.min(target.hp + amount, target.maxHp);
            target.deathSaves = null;
            const back = before === 0 ? ', conscious again' : '';
            lines.push(`${target.name} heals ${amount}: ${before} → ${target.hp} HP${back}`);
        }
        return `${lines.join('\n')}\n\n${render(track)}`;
    },

    revive(track, args) {
        const entries = asBatch(args.revive, 'revive');
        const lines = [];
        for (const entry of entries) {
            const target = find(track, entry.name);
            if (!isDead(target)) {
                throw new ToolError(`${target.name} is not dead. Use "heal" for a living or dying character.`);
            }

            const hp = entry.hp === undefined ? 1 : positiveAmount(entry.hp, entry.name, 'hp');
            target.hp = Math.min(hp, target.maxHp);
            target.deathSaves = null;
            lines.push(`${target.name} is raised from the dead on ${target.hp} HP.`);
        }
        return `${lines.join('\n')}\n\n${render(track)}`;
    },

    death_save(track, args) {
        const saves = asBatch(args.deathSaves, 'deathSaves');
        const lines = [];

        for (const entry of saves) {
            const target = find(track, entry.name);
            if (!target.isPC) {
                throw new ToolError(`${target.name} is not a player character; NPCs die at 0 HP rather than rolling death saves.`);
            }
            if (target.hp > 0) {
                throw new ToolError(`${target.name} is on ${target.hp} HP and is not dying.`);
            }
            target.deathSaves ??= { successes: 0, failures: 0 };
            const state = target.deathSaves;
            if (state.failures >= 3) {
                throw new ToolError(`${target.name} is already dead.`);
            }
            if (state.successes >= 3) {
                throw new ToolError(`${target.name} is stable and no longer rolls death saves.`);
            }

            let result = entry.roll;
            if (!Number.isInteger(result)) {
                result = roll('1d20').total;
            } else if (result < 1 || result > 20) {
                throw new ToolError(`"roll" for ${target.name} must be a d20 result between 1 and 20.`);
            }

            if (result === 20) {
                target.hp = 1;
                target.deathSaves = null;
                lines.push(`${target.name} rolls ${result} — natural 20, back up on 1 HP.`);
                continue;
            }
            if (result === 1) {
                state.failures += 2;
                lines.push(`${target.name} rolls ${result} — natural 1, two failures.`);
            } else if (result >= 10) {
                state.successes += 1;
                lines.push(`${target.name} rolls ${result} — success.`);
            } else {
                state.failures += 1;
                lines.push(`${target.name} rolls ${result} — failure.`);
            }

            if (state.failures >= 3) {
                lines.push(`${target.name} has failed three death saves and is DEAD.`);
            } else if (state.successes >= 3) {
                lines.push(`${target.name} has succeeded three times and is stable, still unconscious.`);
            }
        }

        return `${lines.join('\n')}\n\n${render(track)}`;
    },

    status(track) {
        return render(track);
    },

    clear(track) {
        track.active = false;
        track.combatants = [];
        return 'Encounter cleared.';
    },
};

export default {
    name: 'combat_tracker',
    displayName: 'Combat Tracker',
    stateKeys: ['combat'],
    actionFields: {
        add: ['combatants'],
        remove: ['names'],
        damage: ['damage'],
        heal: ['heal'],
        death_save: ['deathSaves'],
        revive: ['revive'],
        status: [],
        clear: [],
    },
    description: 'Who is in the fight, in initiative order, with HP. add starts the encounter and rolls initiative. Add every creature in one call and batch damage across targets. [DOWN] is unconscious and dying; only [DEAD] is dead.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'remove', 'damage', 'heal', 'death_save', 'revive', 'status', 'clear'],
                description: 'status reads the order without changing it — call it whenever the fight is unclear. revive needs magic like Revivify; ordinary healing cannot raise the dead. clear ends the encounter. All actions return the current order.',
            },
            combatants: {
                type: 'array',
                description: 'For add. One per creature; duplicates need distinct names.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        initiativeModifier: { type: 'integer', description: 'Dexterity modifier: for DEX 14 pass 2, not 14.' },
                        maxHp: { type: 'integer', description: 'Hit point maximum, at least 1.' },
                        hp: { type: 'integer', description: 'Current HP if already hurt. Defaults to maxHp.' },
                        isPC: { type: 'boolean', description: 'Player characters fall unconscious at 0 HP and roll death saves; everyone else dies.' },
                    },
                    required: ['name', 'maxHp'],
                },
            },
            names: {
                type: 'array',
                items: { type: 'string' },
                description: 'For remove.',
            },
            damage: {
                type: 'array',
                description: 'For damage. A target already at 0 HP loses a death save instead of HP.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        amount: { type: 'integer', description: 'Positive. Use heal to restore HP.' },
                        crit: { type: 'boolean', description: 'Critical hit. Only matters at 0 HP, where it costs two death saves.' },
                    },
                    required: ['name', 'amount'],
                },
            },
            heal: {
                type: 'array',
                description: 'For heal. Wakes a dying character; cannot touch a dead one.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        amount: { type: 'integer', description: 'Positive.' },
                    },
                    required: ['name', 'amount'],
                },
            },
            revive: {
                type: 'array',
                description: 'For revive. Only characters marked [DEAD].',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        hp: { type: 'integer', description: 'HP to return on. Defaults to 1.' },
                    },
                    required: ['name'],
                },
            },
            deathSaves: {
                type: 'array',
                description: 'For death_save. One per dying character.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        roll: { type: 'integer', description: 'A d20 result rolled elsewhere. Rolled automatically if omitted.' },
                    },
                    required: ['name'],
                },
            },
        },
        required: ['action'],
    },
    action: async (args) => {
        const handler = handlers[args.action];
        if (!handler) {
            throw new ToolError(`Unknown action "${args.action}".`);
        }
        return transaction(args.action === 'status', state => handler(state.combat, args));
    },
};
