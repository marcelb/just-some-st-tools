import { ToolError } from './errors.js';

const MAX_DICE = 500;
const MAX_FACES = 1000;
const MAX_EXPLOSIONS = 100;

const TERM_PATTERN = /^(\d*)d(\d+|%)((?:(?:kh|kl|dh|dl|r)\d*|!)*)$/i;
const MODIFIER_PATTERN = /(kh|kl|dh|dl|r)(\d*)|(!)/gi;

function rollDie(faces) {
    const limit = Math.floor(0x100000000 / faces) * faces;
    const buffer = new Uint32Array(1);
    let value;
    do {
        crypto.getRandomValues(buffer);
        value = buffer[0];
    } while (value >= limit);
    return (value % faces) + 1;
}

function parseModifiers(source, faces) {
    const mods = { explode: false, reroll: null, keep: null };
    if (!source) {
        return mods;
    }

    MODIFIER_PATTERN.lastIndex = 0;
    let match;
    while ((match = MODIFIER_PATTERN.exec(source)) !== null) {
        if (match[3]) {
            if (faces < 2) {
                throw new ToolError('Exploding dice need at least 2 faces.');
            }
            mods.explode = true;
            continue;
        }

        const kind = match[1].toLowerCase();
        const count = match[2] === '' ? 1 : Number(match[2]);

        if (kind === 'r') {
            if (match[2] === '') {
                throw new ToolError('Reroll needs a threshold, e.g. 4d6r1.');
            }
            if (count >= faces) {
                throw new ToolError(`Reroll threshold ${count} would reroll every die on a d${faces}.`);
            }
            mods.reroll = count;
            continue;
        }

        if (mods.keep) {
            throw new ToolError('Only one keep/drop modifier is allowed per term.');
        }
        mods.keep = { kind, count };
    }
    return mods;
}

function applyKeep(dice, keep) {
    if (!keep) {
        return;
    }
    const order = [...dice].sort((a, b) => a.value - b.value);
    const { kind, count } = keep;

    if (count > dice.length) {
        throw new ToolError(`Cannot ${kind}${count} from only ${dice.length} dice.`);
    }

    let discarded;
    switch (kind) {
        case 'kh': discarded = order.slice(0, order.length - count); break;
        case 'kl': discarded = order.slice(count); break;
        case 'dh': discarded = order.slice(order.length - count); break;
        case 'dl': discarded = order.slice(0, count); break;
        default: discarded = [];
    }
    for (const die of discarded) {
        die.kept = false;
    }
}

function rollTerm(count, faces, mods) {
    const dice = [];

    for (let i = 0; i < count; i++) {
        let value = rollDie(faces);
        let rerolled = false;

        if (mods.reroll !== null && value <= mods.reroll) {
            value = rollDie(faces);
            rerolled = true;
        }
        dice.push({ value, kept: true, rerolled, exploded: false });

        if (mods.explode) {
            let current = value;
            let bursts = 0;
            while (current === faces && bursts < MAX_EXPLOSIONS) {
                current = rollDie(faces);
                dice.push({ value: current, kept: true, rerolled: false, exploded: true });
                bursts++;
            }
        }
    }

    applyKeep(dice, mods.keep);
    return dice;
}

export function roll(notation) {
    if (typeof notation !== 'string' || !notation.trim()) {
        throw new ToolError('Missing dice notation.');
    }

    const cleaned = notation.replace(/\s+/g, '').toLowerCase();
    if (!/^[+-]?[0-9d%khlr!+-]+$/.test(cleaned)) {
        throw new ToolError(`Unrecognised characters in "${notation}".`);
    }

    const parts = cleaned.match(/[+-]?[^+-]+/g);
    if (!parts) {
        throw new ToolError(`Could not parse "${notation}".`);
    }

    let total = 0;
    const terms = [];
    const pieces = [];

    for (const part of parts) {
        const sign = part.startsWith('-') ? -1 : 1;
        const body = part.replace(/^[+-]/, '');

        if (/^\d+$/.test(body)) {
            const value = Number(body) * sign;
            total += value;
            terms.push({ kind: 'constant', value });
            pieces.push(sign < 0 ? `- ${body}` : `+ ${body}`);
            continue;
        }

        const match = TERM_PATTERN.exec(body);
        if (!match) {
            throw new ToolError(`Could not parse "${part}" in "${notation}".`);
        }

        const count = match[1] === '' ? 1 : Number(match[1]);
        const faces = match[2] === '%' ? 100 : Number(match[2]);

        if (count < 1 || count > MAX_DICE) {
            throw new ToolError(`Dice count must be between 1 and ${MAX_DICE}.`);
        }
        if (faces < 1 || faces > MAX_FACES) {
            throw new ToolError(`Die size must be between 1 and ${MAX_FACES}.`);
        }

        const dice = rollTerm(count, faces, parseModifiers(match[3], faces));
        const sum = dice.reduce((acc, d) => acc + (d.kept ? d.value : 0), 0) * sign;
        total += sum;

        terms.push({ kind: 'dice', count, faces, dice, subtotal: sum });
        const shown = dice.map(d => {
            let text = String(d.value);
            if (d.exploded) text = `${text}!`;
            if (d.rerolled) text = `${text}r`;
            return d.kept ? text : `~~${text}~~`;
        }).join(', ');
        pieces.push(`${sign < 0 ? '- ' : '+ '}${body} [${shown}]`);
    }

    const breakdown = pieces.join(' ').replace(/^\+\s*/, '');
    return { total, breakdown, terms };
}

export function applyAdvantage(notation, mode) {
    if (!mode || mode === 'none') {
        return notation;
    }
    if (mode !== 'advantage' && mode !== 'disadvantage') {
        throw new ToolError(`"advantage" must be none, advantage or disadvantage, got "${mode}".`);
    }

    const cleaned = String(notation).replace(/\s+/g, '').toLowerCase();
    const parts = cleaned.match(/[+-]?[^+-]+/g) ?? [];

    const found = [];
    parts.forEach((part, index) => {
        const match = TERM_PATTERN.exec(part.replace(/^[+-]/, ''));
        if (match && match[2] !== '%' && Number(match[2]) === 20) {
            found.push({ index, part, match });
        }
    });

    if (found.length === 0) {
        throw new ToolError(`${mode} applies to 1d20 tests, and "${notation}" has no 1d20.`);
    }
    if (found.length > 1) {
        throw new ToolError(`"${notation}" has more than one d20 term, so there is no single test to apply ${mode} to.`);
    }

    const { index, part, match } = found[0];
    if (part.startsWith('-')) {
        throw new ToolError(`The d20 in "${notation}" is subtracted, which is not a d20 test.`);
    }
    if (match[1] !== '' && Number(match[1]) !== 1) {
        throw new ToolError(`"${notation}" already rolls ${match[1]}d20. Advantage only applies to 1d20 + x throws.`);
    }
    if (match[3]) {
        throw new ToolError(`The d20 in "${notation}" already carries "${match[3]}". Use the notation or the advantage flag, not both.`);
    }

    parts[index] = `${part.startsWith('+') ? '+' : ''}2d20${mode === 'advantage' ? 'kh1' : 'kl1'}`;
    return parts.join('');
}
