import test from 'node:test';
import assert from 'node:assert/strict';

import { installContext, removeContext } from './helpers.js';
import { ToolError } from '../lib/errors.js';

import dice from '../tools/dice.js';
import combat from '../tools/combat.js';
import notes from '../tools/notes.js';
import tables from '../tools/tables.js';
import time from '../tools/time.js';

test('roll_dice batches every roll into one result', async () => {
    const output = await dice.action({
        rolls: [
            { notation: '1d20+5', label: 'Attack' },
            { notation: '2d6+3', label: 'Damage' },
        ],
    });
    const lines = output.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Attack: \*\*-?\d+\*\*/);
    assert.match(lines[1], /^Damage: \*\*-?\d+\*\*/);
});

test('roll_dice reports success and failure against a DC', async () => {
    const pass = await dice.action({ rolls: [{ notation: '1d20+100', dc: 15, label: 'Check' }] });
    assert.match(pass, /SUCCESS vs DC 15/);
    const fail = await dice.action({ rolls: [{ notation: '1d20-100', dc: 15, label: 'Check' }] });
    assert.match(fail, /FAIL vs DC 15/);
});

test('roll_dice isolates a bad entry instead of failing the whole batch', async () => {
    const output = await dice.action({
        rolls: [{ notation: 'nonsense', label: 'Bad' }, { notation: '1d6', label: 'Good' }],
    });
    assert.match(output, /Bad: ERROR/);
    assert.match(output, /Good: \*\*\d+\*\*/);
});

test('roll_dice rejects an empty batch', async () => {
    await assert.rejects(() => dice.action({ rolls: [] }), ToolError);
});

test('state tools refuse to run without an active chat', async () => {
    removeContext();
    await assert.rejects(() => notes.action({ action: 'list' }), ToolError);
    installContext();
});

/** The tracker always rolls initiative itself, so tests assert on order, not values. */
function initiativeOrder(output) {
    return output
        .split('\n')
        .filter(line => /^\s*-?\d+ — /.test(line))
        .map(line => Number(/^\s*(-?\d+) — /.exec(line)[1]));
}

test('combat sorts high to low and rolls initiative automatically', async () => {
    installContext();
    const output = await combat.action({
        action: 'add',
        combatants: [
            { name: 'Goblin 1', maxHp: 7 },
            { name: 'Rogue', maxHp: 24, initiativeModifier: 5, isPC: true },
            { name: 'Goblin 2', maxHp: 7 },
        ],
    });
    assert.match(output, /Added: Goblin 1 \(init -?\d+\)/);

    const rolls = initiativeOrder(await combat.action({ action: 'status' }));
    assert.equal(rolls.length, 3);
    assert.deepEqual(rolls, [...rolls].sort((a, b) => b - a));
    for (const value of rolls) {
        assert.ok(value >= 1 && value <= 25, `initiative ${value} out of range`);
    }
});

test('status reports the order without persisting anything', async () => {
    const ctx = installContext();
    assert.match(await combat.action({ action: 'status' }), /No encounter is running/);
    await combat.action({ action: 'add', combatants: [{ name: 'Orc', maxHp: 15 }] });
    const before = ctx.saveCount;
    assert.match(await combat.action({ action: 'status' }), /Orc/);
    assert.equal(ctx.saveCount, before);
});

test('combat rejects duplicate and unknown names', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Goblin', maxHp: 7 }] });
    await assert.rejects(
        () => combat.action({ action: 'add', combatants: [{ name: 'goblin', maxHp: 7 }] }),
        ToolError);
    await assert.rejects(
        () => combat.action({ action: 'damage', damage: [{ name: 'Dragon', amount: 5 }] }),
        ToolError);
});

test('maxHp is required and must be at least 1', async () => {
    installContext();
    for (const entry of [{ name: 'Ghost' }, { name: 'Ghost', maxHp: 0 }, { name: 'Ghost', maxHp: -3 }]) {
        await assert.rejects(() => combat.action({ action: 'add', combatants: [entry] }), ToolError);
    }
    assert.match(await combat.action({ action: 'status' }), /No encounter is running/);
});

test('hp defaults to full health and cannot start above maximum', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Orc', maxHp: 12 }] });
    assert.match(await combat.action({ action: 'status' }), /Orc \(12\/12 HP\)/);
    await assert.rejects(
        () => combat.action({ action: 'add', combatants: [{ name: 'Bear', maxHp: 12, hp: 20 }] }), ToolError);
});

test('a batch that fails partway changes nothing at all', async () => {
    const ctx = installContext();
    await combat.action({
        action: 'add',
        combatants: [{ name: 'Goblin', maxHp: 10 }, { name: 'Kara', maxHp: 30, isPC: true }],
    });
    const before = await combat.action({ action: 'status' });
    const saves = ctx.saveCount;

    // Second entry names nobody, so the first must not have landed either.
    await assert.rejects(
        () => combat.action({
            action: 'damage',
            damage: [{ name: 'Goblin', amount: 4 }, { name: 'Typo', amount: 4 }],
        }), ToolError);
    assert.equal(await combat.action({ action: 'status' }), before);
    assert.equal(ctx.saveCount, saves);

    // A duplicate name mid-batch must not add the valid entry ahead of it.
    await assert.rejects(
        () => combat.action({
            action: 'add',
            combatants: [{ name: 'Wolf', maxHp: 11 }, { name: 'goblin', maxHp: 10 }],
        }), ToolError);
    assert.doesNotMatch(await combat.action({ action: 'status' }), /Wolf/);

    // And the corrected batch applies exactly once.
    await combat.action({ action: 'damage', damage: [{ name: 'Goblin', amount: 4 }, { name: 'Kara', amount: 4 }] });
    assert.match(await combat.action({ action: 'status' }), /Goblin \(6\/10 HP\)/);
});

test('every mutating action rolls its whole batch back on a bad entry', async () => {
    installContext();
    await combat.action({
        action: 'add',
        combatants: [
            { name: 'Kara', maxHp: 30, hp: 10, isPC: true },
            { name: 'Borin', maxHp: 20, hp: 10, isPC: true },
            { name: 'Orc', maxHp: 12 },
        ],
    });
    // Borin is dead and Kara is dying, which is the state each batch below must preserve.
    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 10 }, { name: 'Borin', amount: 10 }] });
    for (let i = 0; i < 3; i++) {
        await combat.action({ action: 'death_save', deathSaves: [{ name: 'Borin', roll: 5 }] });
    }
    const before = await combat.action({ action: 'status' });

    // Each batch has a good first entry and a second that must undo it.
    const batches = [
        { action: 'heal', heal: [{ name: 'Orc', amount: 5 }, { name: 'Typo', amount: 5 }] },
        { action: 'revive', revive: [{ name: 'Borin' }, { name: 'Typo' }] },
        { action: 'death_save', deathSaves: [{ name: 'Kara', roll: 15 }, { name: 'Typo' }] },
        { action: 'remove', names: ['Orc', 'Typo'] },
        // A later entry that is invalid on its own terms, not just an unknown name.
        { action: 'damage', damage: [{ name: 'Orc', amount: 3 }, { name: 'Kara', amount: -1 }] },
        { action: 'heal', heal: [{ name: 'Orc', amount: 3 }, { name: 'Borin', amount: 5 }] },
    ];
    for (const args of batches) {
        await assert.rejects(() => combat.action(args), ToolError, `${args.action} should have rejected`);
        assert.equal(await combat.action({ action: 'status' }), before, `${args.action} left state changed`);
    }
});

test('revive rejects a non-positive hp', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Orc', maxHp: 12 }] });
    await combat.action({ action: 'damage', damage: [{ name: 'Orc', amount: 12 }] });
    for (const hp of [0, -5]) {
        await assert.rejects(() => combat.action({ action: 'revive', revive: [{ name: 'Orc', hp }] }), ToolError);
    }
    assert.match(await combat.action({ action: 'status' }), /\[DEAD\]/);
});

test('an NPC dropped to 0 HP is dead outright', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Orc', hp: 15, maxHp: 15 }] });
    const output = await combat.action({ action: 'damage', damage: [{ name: 'Orc', amount: 40 }] });
    assert.match(output, /Orc takes 40: 15 → 0 HP \[DEAD\]/);
});

test('a player character dropped to 0 HP starts dying, not dead', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Kara', hp: 12, maxHp: 30, isPC: true }] });
    const output = await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 12 }] });
    assert.match(output, /\[DOWN, death saves 0\/3 passed, 0\/3 failed\]/);
    assert.doesNotMatch(output, /\[DEAD\]/);
});

test('damage and heal both refuse anything but a positive amount', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Orc', hp: 15, maxHp: 15 }] });
    for (const amount of [-5, 0]) {
        await assert.rejects(
            () => combat.action({ action: 'damage', damage: [{ name: 'Orc', amount }] }), ToolError);
        await assert.rejects(
            () => combat.action({ action: 'heal', heal: [{ name: 'Orc', amount }] }), ToolError);
    }
});

test('healing cannot exceed maximum HP', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Orc', hp: 5, maxHp: 15 }] });
    const output = await combat.action({ action: 'heal', heal: [{ name: 'Orc', amount: 100 }] });
    assert.match(output, /Orc heals 100: 5 → 15 HP/);
});

test('healing a dying character wakes them and clears their death saves', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Kara', hp: 12, maxHp: 30, isPC: true }] });
    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 12 }] });
    await combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 5 }] });
    const output = await combat.action({ action: 'heal', heal: [{ name: 'Kara', amount: 4 }] });
    assert.match(output, /Kara heals 4: 0 → 4 HP, conscious again/);
    assert.doesNotMatch(output, /death saves/);
});

test('damage to a dying character costs a death save instead of HP', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Kara', hp: 5, maxHp: 30, isPC: true }] });
    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 5 }] });
    const once = await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 3 }] });
    assert.match(once, /automatic death save failure/);
    assert.match(once, /0\/3 passed, 1\/3 failed/);

    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 3 }] });
    const dead = await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 3 }] });
    assert.match(dead, /\[DEAD\]/);
});

test('a critical hit on a downed character costs two death saves', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Kara', hp: 5, maxHp: 30, isPC: true }] });
    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 5 }] });
    const crit = await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 9, crit: true }] });
    assert.match(crit, /critically hit while down: 2 automatic death save failure/);
    assert.match(crit, /0\/3 passed, 2\/3 failed/);

    const dead = await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 2, crit: true }] });
    assert.match(dead, /\[DEAD\]/);
});

test('crit is ignored while a target still has HP', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Orc', hp: 15, maxHp: 15 }] });
    const output = await combat.action({ action: 'damage', damage: [{ name: 'Orc', amount: 6, crit: true }] });
    assert.match(output, /Orc takes 6: 15 → 9 HP/);
    assert.doesNotMatch(output, /death save/);
});

test('the dead cannot be damaged or healed back', async () => {
    installContext();
    await combat.action({
        action: 'add',
        combatants: [{ name: 'Orc', maxHp: 5 }, { name: 'Kara', maxHp: 5, isPC: true }],
    });
    await combat.action({ action: 'damage', damage: [{ name: 'Orc', amount: 5 }] });
    await assert.rejects(() => combat.action({ action: 'damage', damage: [{ name: 'Orc', amount: 1 }] }), ToolError);
    await assert.rejects(() => combat.action({ action: 'heal', heal: [{ name: 'Orc', amount: 10 }] }), ToolError);

    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 5 }] });
    await combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 1 }] });
    await combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 1 }] });
    await assert.rejects(() => combat.action({ action: 'heal', heal: [{ name: 'Kara', amount: 10 }] }), ToolError);
});

test('revive only works on the dead, and brings them back on 1 HP by default', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Orc', hp: 5, maxHp: 12 }] });
    await assert.rejects(() => combat.action({ action: 'revive', revive: [{ name: 'Orc' }] }), ToolError);

    await combat.action({ action: 'damage', damage: [{ name: 'Orc', amount: 5 }] });
    const output = await combat.action({ action: 'revive', revive: [{ name: 'Orc' }] });
    assert.match(output, /Orc is raised from the dead on 1 HP/);
    assert.doesNotMatch(output, /DEAD/);

    await combat.action({ action: 'damage', damage: [{ name: 'Orc', amount: 1 }] });
    const full = await combat.action({ action: 'revive', revive: [{ name: 'Orc', hp: 99 }] });
    assert.match(full, /raised from the dead on 12 HP/);
});

test('a dying player character can be revived after failing three saves', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Kara', hp: 5, maxHp: 30, isPC: true }] });
    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 5 }] });
    for (let i = 0; i < 3; i++) {
        await combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 5 }] });
    }
    assert.match(await combat.action({ action: 'status' }), /Kara \(0\/30 HP\) \[DEAD\]/);
    const output = await combat.action({ action: 'revive', revive: [{ name: 'Kara', hp: 10 }] });
    assert.match(output, /Kara \(10\/30 HP\)/);
    assert.doesNotMatch(output, /DEAD/);
});

test('death saves follow the natural 1 and natural 20 rules', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Kara', hp: 5, maxHp: 30, isPC: true }] });
    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 5 }] });

    const critFail = await combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 1 }] });
    assert.match(critFail, /natural 1, two failures/);
    assert.match(critFail, /0\/3 passed, 2\/3 failed/);

    const critSuccess = await combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 20 }] });
    assert.match(critSuccess, /natural 20, back up on 1 HP/);
    assert.match(critSuccess, /Kara \(1\/30 HP\)/);
});

test('three successful death saves leave a character stable but unconscious', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Kara', hp: 5, maxHp: 30, isPC: true }] });
    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 5 }] });
    let output;
    for (let i = 0; i < 3; i++) {
        output = await combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 15 }] });
    }
    assert.match(output, /\[DOWN, stable\]/);
    await assert.rejects(
        () => combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 15 }] }), ToolError);
});

test('damage to a stable character ends the stable condition and restarts the dying', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Kara', maxHp: 30, hp: 5, isPC: true }] });
    await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 5 }] });
    for (let i = 0; i < 3; i++) {
        await combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 15 }] });
    }
    assert.match(await combat.action({ action: 'status' }), /\[DOWN, stable\]/);

    const hit = await combat.action({ action: 'damage', damage: [{ name: 'Kara', amount: 3 }] });
    assert.match(hit, /no longer stable/);
    assert.match(hit, /0\/3 passed, 1\/3 failed/);
    assert.doesNotMatch(hit, /stable\]/);

    // The successes are gone, so she has to roll her way back out again.
    const rolled = await combat.action({ action: 'death_save', deathSaves: [{ name: 'Kara', roll: 15 }] });
    assert.match(rolled, /1\/3 passed, 1\/3 failed/);
});

test('death saves are for player characters only', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'Orc', maxHp: 5 }] });
    await assert.rejects(
        () => combat.action({ action: 'death_save', deathSaves: [{ name: 'Orc' }] }), ToolError);
});

test('removing the last combatant ends the encounter', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'A', maxHp: 5 }, { name: 'B', maxHp: 5 }] });
    assert.match(await combat.action({ action: 'remove', names: ['A'] }), /Removed: A/);
    assert.match(await combat.action({ action: 'remove', names: ['B'] }), /encounter over/);
    assert.match(await combat.action({ action: 'status' }), /No encounter is running/);
});

test('clear empties the tracker', async () => {
    installContext();
    await combat.action({ action: 'add', combatants: [{ name: 'A', maxHp: 5 }] });
    assert.match(await combat.action({ action: 'clear' }), /Encounter cleared/);
    assert.match(await combat.action({ action: 'status' }), /No encounter is running/);
});

test('notes write, append, read and delete by key', async () => {
    installContext();
    await notes.action({ action: 'write', notes: [{ key: 'tavern', text: 'The Rusted Anchor' }] });
    await notes.action({ action: 'append', notes: [{ key: 'Tavern', text: 'Barkeep: Willa' }] });
    const read = await notes.action({ action: 'read', keys: ['tavern'] });
    assert.match(read, /The Rusted Anchor\nBarkeep: Willa/);

    assert.match(await notes.action({ action: 'list' }), /tavern/);
    await notes.action({ action: 'delete', keys: ['tavern'] });
    assert.match(await notes.action({ action: 'list' }), /No notes/);
    await assert.rejects(() => notes.action({ action: 'delete', keys: ['tavern'] }), ToolError);
});

test('appending to a missing note creates it', async () => {
    installContext();
    await notes.action({ action: 'append', notes: [{ key: 'fresh', text: 'first line' }] });
    assert.match(await notes.action({ action: 'read', keys: ['fresh'] }), /first line/);
});

test('random tables respect weights', async () => {
    installContext();
    await tables.action({
        action: 'define',
        tables: [{
            name: 'Loot',
            entries: [
                { result: 'common', weight: 99 },
                { result: 'rare', weight: 1 },
            ],
        }],
    });

    let common = 0;
    for (let i = 0; i < 400; i++) {
        const output = await tables.action({ action: 'roll', rolls: [{ name: 'loot' }] });
        if (output.includes('common')) common++;
    }
    assert.ok(common > 340, `weighting looks wrong: ${common}/400 common`);
});

test('unique draws never repeat and cannot exceed the table size', async () => {
    installContext();
    await tables.action({
        action: 'define',
        tables: [{ name: 'Names', entries: [{ result: 'a' }, { result: 'b' }, { result: 'c' }] }],
    });
    const output = await tables.action({ action: 'roll', rolls: [{ name: 'Names', count: 3, unique: true }] });
    for (const name of ['a', 'b', 'c']) {
        assert.equal(output.match(new RegExp(`- ${name}$`, 'gm')).length, 1);
    }
    await assert.rejects(
        () => tables.action({ action: 'roll', rolls: [{ name: 'Names', count: 4, unique: true }] }),
        ToolError);
});

test('defining over an existing table is refused, not silently replaced', async () => {
    installContext();
    await tables.action({ action: 'define', tables: [{ name: 'Loot', entries: [{ result: 'a' }, { result: 'b' }] }] });

    // The key folds case, so "loot" would otherwise overwrite "Loot".
    await assert.rejects(
        () => tables.action({ action: 'define', tables: [{ name: 'loot', entries: [{ result: 'z' }] }] }),
        (error) => error instanceof ToolError && /"Loot" already exists with 2 entries/.test(error.message));
    assert.match(await tables.action({ action: 'list' }), /Loot \(2 entries\)/);

    // A collision inside one batch counts too, and takes the whole batch with it.
    await assert.rejects(
        () => tables.action({
            action: 'define',
            tables: [{ name: 'Gems', entries: [{ result: 'ruby' }] }, { name: 'Gems', entries: [{ result: 'opal' }] }],
        }), ToolError);
    assert.doesNotMatch(await tables.action({ action: 'list' }), /Gems/);

    // Deleting first is the deliberate way through.
    await tables.action({ action: 'delete', names: ['Loot'] });
    await tables.action({ action: 'define', tables: [{ name: 'loot', entries: [{ result: 'z' }] }] });
    assert.match(await tables.action({ action: 'list' }), /loot \(1 entries\)/);
});

test('count must be a whole number in range', async () => {
    installContext();
    await tables.action({ action: 'define', tables: [{ name: 'Loot', entries: [{ result: 'a' }, { result: 'b' }] }] });
    for (const count of [0, 101, 1.5, '2']) {
        await assert.rejects(
            () => tables.action({ action: 'roll', rolls: [{ name: 'Loot', count }] }),
            ToolError, `count ${JSON.stringify(count)} should have been rejected`);
    }
    // Omitted or explicitly null both mean one draw; models write null for "not applicable".
    for (const roll of [{ name: 'Loot' }, { name: 'Loot', count: null }]) {
        assert.match(await tables.action({ action: 'roll', rolls: [roll] }), /^Loot: [ab]$/);
    }
});

test('rolling an undefined table lists what is available', async () => {
    installContext();
    await tables.action({ action: 'define', tables: [{ name: 'Loot', entries: [{ result: 'x' }] }] });
    await assert.rejects(
        () => tables.action({ action: 'roll', rolls: [{ name: 'Encounters' }] }),
        (error) => error instanceof ToolError && /Available: Loot/.test(error.message));
});

test('table entries need a positive weight', async () => {
    installContext();
    await assert.rejects(
        () => tables.action({ action: 'define', tables: [{ name: 'T', entries: [{ result: 'x', weight: 0 }] }] }),
        ToolError);
});

test('the clock starts at morning on day one', async () => {
    installContext();
    assert.match(await time.action({ action: 'show' }), /Day 1 — 08:00 \(morning\)/);
});

test('advancing time rolls over into the next day', async () => {
    installContext();
    await time.action({ action: 'advance', amount: 20, unit: 'hours' });
    assert.match(await time.action({ action: 'show' }), /Day 2 — 04:00 \(night\)/);
});

test('every unit converts correctly', async () => {
    for (const [amount, unit, expected] of [
        [90, 'minutes', /Day 1 — 09:30/],
        [1, 'hours', /Day 1 — 09:00/],
        [1.5, 'hours', /Day 1 — 09:30/],
        [1, 'days', /Day 2 — 08:00/],
        [1, 'weeks', /Day 8 — 08:00/],
        [1, 'months', /Day 31 — 08:00/],
        [1, 'years', /Day 366 — 08:00/],
    ]) {
        installContext();
        await time.action({ action: 'advance', amount, unit });
        assert.match(await time.action({ action: 'show' }), expected, `${amount} ${unit} misconverted`);
    }
});

test('advance rejects a missing, malformed or absurd amount', async () => {
    installContext();
    for (const args of [
        { action: 'advance' },
        { action: 'advance', unit: 'hours' },
        { action: 'advance', amount: '2', unit: 'hours' },
        { action: 'advance', amount: 2 },
        { action: 'advance', amount: 2, unit: 'fortnights' },
        { action: 'advance', amount: 0, unit: 'hours' },
        { action: 'advance', amount: -5, unit: 'hours' },
        { action: 'advance', amount: 0.001, unit: 'minutes' },
        { action: 'advance', amount: 1000, unit: 'years' },
    ]) {
        await assert.rejects(() => time.action(args), ToolError, `${JSON.stringify(args)} should have been rejected`);
    }
    assert.match(await time.action({ action: 'show' }), /Day 1 — 08:00/);
});

test('time only moves forward and set jumps to an absolute point', async () => {
    installContext();
    await time.action({ action: 'set', day: 10, time: '23:15' });
    assert.match(await time.action({ action: 'show' }), /Day 10 — 23:15 \(night\)/);
    await assert.rejects(() => time.action({ action: 'set', time: '25:00' }), ToolError);
    await assert.rejects(() => time.action({ action: 'set', time: 'evening' }), ToolError);
});

test('set rejects empty and malformed arguments', async () => {
    installContext();
    for (const args of [
        { action: 'set' },
        { action: 'set', day: 0 },
        { action: 'set', day: -1 },
        { action: 'set', day: 2.5 },
        { action: 'set', day: '5' },
        { action: 'set', time: '25:00' },
        { action: 'set', time: 'evening' },
    ]) {
        await assert.rejects(() => time.action(args), ToolError, `${JSON.stringify(args)} should have been rejected`);
    }
    assert.match(await time.action({ action: 'show' }), /Day 1 — 08:00/);
});

test('set clears the timeline, because elapsed times no longer mean anything', async () => {
    installContext();
    await time.action({ action: 'advance', amount: 3, unit: 'days', note: 'Travel' });
    assert.match(await time.action({ action: 'history' }), /Travel/);

    const output = await time.action({ action: 'set', day: 40 });
    assert.match(output, /timeline cleared, 1 entry dropped/);
    assert.match(await time.action({ action: 'history' }), /No time has been advanced/);

    // Nothing to drop means nothing to report.
    assert.doesNotMatch(await time.action({ action: 'set', day: 41 }), /timeline/);
});

test('the timeline records notes about what happened', async () => {
    installContext();
    await time.action({ action: 'advance', amount: 3, unit: 'days', note: 'Travel to Neverwinter' });
    assert.match(await time.action({ action: 'history' }), /Day 4 08:00 \(\+3 day\(s\)\) — Travel to Neverwinter/);
});

test('every mutating tool persists chat metadata', async () => {
    const ctx = installContext();
    const before = ctx.saveCount;
    await notes.action({ action: 'write', notes: [{ key: 'k', text: 'v' }] });
    await combat.action({ action: 'add', combatants: [{ name: 'X', maxHp: 1 }] });
    await time.action({ action: 'advance', amount: 1, unit: 'hours' });
    assert.equal(ctx.saveCount, before + 3);
});

test('a failed batch changes nothing in any stateful tool', async () => {
    const ctx = installContext();
    await notes.action({ action: 'write', notes: [{ key: 'a', text: 'keep me' }, { key: 'b', text: 'me too' }] });
    await tables.action({ action: 'define', tables: [{ name: 'Loot', entries: [{ result: 'gold' }] }] });
    await time.action({ action: 'set', day: 3, time: '09:00' });

    // Each pair is a read that captures the state, and a batch that must not change it.
    const cases = [
        [() => notes.action({ action: 'read' }),
            { tool: notes, args: { action: 'delete', keys: ['a', 'ghost'] } },
            { tool: notes, args: { action: 'write', notes: [{ key: 'b', text: 'clobbered' }, { key: 'c', text: '' }] } }],
        [() => tables.action({ action: 'list' }),
            { tool: tables, args: { action: 'delete', names: ['Loot', 'ghost'] } },
            { tool: tables, args: { action: 'define', tables: [{ name: 'Gems', entries: [{ result: 'ruby' }] }, { name: 'Bad', entries: [{ result: 'x', weight: 0 }] }] } }],
        [() => time.action({ action: 'show' }),
            { tool: time, args: { action: 'set', day: 9, time: '25:00' } }],
    ];

    for (const [read, ...batches] of cases) {
        const before = await read();
        for (const { tool, args } of batches) {
            await assert.rejects(() => tool.action(args), ToolError, `${tool.name}/${args.action} should have rejected`);
            assert.equal(await read(), before, `${tool.name}/${args.action} left state changed`);
        }
    }

    // The reads above must not have dirtied the chat either.
    const saves = ctx.saveCount;
    await notes.action({ action: 'list' });
    await tables.action({ action: 'roll', rolls: [{ name: 'Loot' }] });
    await tables.action({ action: 'show', names: ['Loot'] });
    await time.action({ action: 'history' });
    assert.equal(ctx.saveCount, saves);
});

test('state is stored under a single namespaced key in chat metadata', async () => {
    const ctx = installContext();
    await notes.action({ action: 'write', notes: [{ key: 'k', text: 'v' }] });
    assert.deepEqual(Object.keys(ctx.metadata), ['justSomeStTools']);
});
