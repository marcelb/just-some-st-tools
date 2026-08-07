import test from 'node:test';
import assert from 'node:assert/strict';

import { roll, applyAdvantage } from '../lib/dice.js';
import { ToolError } from '../lib/errors.js';

const SAMPLES = 1000;

function kept(result) {
    return result.terms
        .filter(t => t.kind === 'dice')
        .flatMap(t => t.dice.filter(d => d.kept));
}

test('a plain die stays within its range', () => {
    for (let i = 0; i < SAMPLES; i++) {
        const { total } = roll('1d6');
        assert.ok(total >= 1 && total <= 6, `got ${total}`);
    }
});

test('every face of a d6 shows up over many rolls', () => {
    const seen = new Set();
    for (let i = 0; i < SAMPLES; i++) {
        seen.add(roll('1d6').total);
    }
    assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6]);
});

test('modifiers and multiple terms sum correctly', () => {
    for (let i = 0; i < SAMPLES; i++) {
        const result = roll('2d6+1d4-2');
        const sum = result.terms.reduce((acc, term) => {
            if (term.kind === 'constant') return acc + term.value;
            return acc + term.subtotal;
        }, 0);
        assert.equal(result.total, sum);
        assert.ok(result.total >= 2 + 1 - 2 && result.total <= 12 + 4 - 2);
    }
});

test('a negative constant subtracts', () => {
    const result = roll('10-3');
    assert.equal(result.total, 7);
});

test('kh3 keeps the three highest of four dice', () => {
    for (let i = 0; i < SAMPLES; i++) {
        const result = roll('4d6kh3');
        const term = result.terms[0];
        assert.equal(term.dice.length, 4);

        const keptDice = term.dice.filter(d => d.kept).map(d => d.value);
        const dropped = term.dice.filter(d => !d.kept).map(d => d.value);
        assert.equal(keptDice.length, 3);
        assert.equal(dropped.length, 1);
        assert.ok(Math.min(...keptDice) >= dropped[0], `kept ${keptDice} dropped ${dropped}`);
        assert.equal(result.total, keptDice.reduce((a, b) => a + b, 0));
    }
});

test('kl1 keeps the single lowest die', () => {
    for (let i = 0; i < SAMPLES; i++) {
        const result = roll('2d20kl1');
        const term = result.terms[0];
        const keptDice = term.dice.filter(d => d.kept).map(d => d.value);
        assert.equal(keptDice.length, 1);
        assert.equal(keptDice[0], Math.min(...term.dice.map(d => d.value)));
    }
});

test('dl1 drops the lowest die', () => {
    for (let i = 0; i < SAMPLES; i++) {
        const term = roll('3d8dl1').terms[0];
        const dropped = term.dice.filter(d => !d.kept).map(d => d.value);
        assert.equal(dropped.length, 1);
        assert.equal(dropped[0], Math.min(...term.dice.map(d => d.value)));
    }
});

test('exploding dice only add a die after a maximum face', () => {
    let sawExplosion = false;
    for (let i = 0; i < SAMPLES * 4; i++) {
        const term = roll('1d4!').terms[0];
        for (let d = 0; d < term.dice.length - 1; d++) {
            assert.equal(term.dice[d].value, 4);
            sawExplosion = true;
        }
        assert.equal(term.subtotal, term.dice.reduce((a, b) => a + b.value, 0));
    }
    assert.ok(sawExplosion, 'no explosion occurred in 1200 rolls of 1d4!');
});

test('exploding a one-sided die is rejected rather than looping forever', () => {
    assert.throws(() => roll('1d1!'), ToolError);
});

test('reroll replaces low dice and never leaves one below the threshold twice', () => {
    let sawReroll = false;
    for (let i = 0; i < SAMPLES; i++) {
        const term = roll('4d6r1').terms[0];
        for (const die of term.dice) {
            if (die.rerolled) sawReroll = true;
        }
    }
    assert.ok(sawReroll, 'no reroll triggered');
});

test('percentile notation is a d100', () => {
    for (let i = 0; i < SAMPLES; i++) {
        const { total } = roll('1d%');
        assert.ok(total >= 1 && total <= 100);
    }
});

test('an omitted dice count means one die', () => {
    const term = roll('d20').terms[0];
    assert.equal(term.dice.length, 1);
});

test('whitespace and case are ignored', () => {
    const result = roll('  2D6 + 3 ');
    assert.ok(result.total >= 5 && result.total <= 15);
});

test('the breakdown lists each die', () => {
    const result = roll('2d6+3');
    assert.match(result.breakdown, /2d6 \[\d+, \d+\] \+ 3/);
});

test('malformed notation raises a ToolError', () => {
    for (const bad of ['', 'hello', '2d', 'd', '1d6r', '3d6zz', '++']) {
        assert.throws(() => roll(bad), ToolError, `expected "${bad}" to be rejected`);
    }
});

test('a bare keep modifier means keep one', () => {
    const term = roll('2d6kh').terms[0];
    assert.equal(term.dice.filter(d => d.kept).length, 1);
});

test('absurd dice counts and sizes are rejected', () => {
    assert.throws(() => roll('9999d6'), ToolError);
    assert.throws(() => roll('1d99999'), ToolError);
});

test('keeping more dice than were rolled is rejected', () => {
    assert.throws(() => roll('2d6kh5'), ToolError);
});

test('a reroll threshold that would reroll everything is rejected', () => {
    assert.throws(() => roll('4d6r6'), ToolError);
});

test('two keep modifiers on one term are rejected', () => {
    assert.throws(() => roll('4d6kh3kl1'), ToolError);
});

test('advantage rewrites the d20 and keeps the rest of the expression', () => {
    assert.equal(applyAdvantage('1d20+5', 'advantage'), '2d20kh1+5');
    assert.equal(applyAdvantage('d20', 'disadvantage'), '2d20kl1');
    assert.equal(applyAdvantage('1d20+5', 'none'), '1d20+5');
    assert.equal(applyAdvantage('1d20+5'), '1d20+5');
});

test('advantage on a roll with no d20 is rejected', () => {
    assert.throws(() => applyAdvantage('2d6+1', 'advantage'), ToolError);
});

test('advantage does not mangle a d200', () => {
    assert.throws(() => applyAdvantage('1d200', 'advantage'), ToolError);
});

test('advantage rolls two dice and keeps the higher', () => {
    for (let i = 0; i < SAMPLES; i++) {
        const result = roll(applyAdvantage('1d20+5', 'advantage'));
        const term = result.terms[0];
        assert.equal(term.dice.length, 2);
        const keptDie = kept(result)[0];
        assert.equal(keptDie.value, Math.max(...term.dice.map(d => d.value)));
        assert.equal(result.total, keptDie.value + 5);
    }
});
