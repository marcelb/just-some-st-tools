import { transaction } from '../lib/state.js';
import { ToolError } from '../lib/errors.js';

const READ_ONLY = new Set(['show', 'history']);
const MINUTES_PER_DAY = 24 * 60;
const UNITS = { minutes: 1, hours: 60, days: MINUTES_PER_DAY, weeks: 7 * MINUTES_PER_DAY, months: 30 * MINUTES_PER_DAY, years: 365 * MINUTES_PER_DAY };
const MAX_ADVANCE = 100 * UNITS.years;

function defaultClock() {
    return { minute: 8 * 60, day: 1, log: [] };
}

function clockOf(state) {
    state.clock ??= defaultClock();
    state.clock.log ??= [];
    return state.clock;
}

function timeOfDay(minute) {
    const hour = Math.floor(minute / 60);
    if (hour < 5) return 'night';
    if (hour < 8) return 'dawn';
    if (hour < 12) return 'morning';
    if (hour < 14) return 'midday';
    if (hour < 18) return 'afternoon';
    if (hour < 21) return 'evening';
    return 'night';
}

function render(clock) {
    const hh = String(Math.floor(clock.minute / 60)).padStart(2, '0');
    const mm = String(clock.minute % 60).padStart(2, '0');
    return `Day ${clock.day} — ${hh}:${mm} (${timeOfDay(clock.minute)})`;
}

function toMinutes(args) {
    if (typeof args.amount !== 'number' || !Number.isFinite(args.amount)) {
        throw new ToolError(`"amount" must be a number, got ${JSON.stringify(args.amount)}. For 90 minutes pass amount 90 and unit "minutes".`);
    }
    if (args.amount <= 0) {
        throw new ToolError('Time can only move forward. Use action "set" to rewind.');
    }
    if (typeof args.unit !== 'string' || !(args.unit in UNITS)) {
        throw new ToolError(`"unit" is required and must be one of: ${Object.keys(UNITS).join(', ')}. Got ${JSON.stringify(args.unit)}.`);
    }

    const minutes = Math.round(args.amount * UNITS[args.unit]);
    if (minutes < 1) {
        throw new ToolError(`${args.amount} ${args.unit} rounds to less than a minute.`);
    }
    if (minutes > MAX_ADVANCE) {
        throw new ToolError(`That is more than ${MAX_ADVANCE / UNITS.years} years in one step. Use action "set" for a jump that large.`);
    }
    return minutes;
}

export default {
    name: 'game_clock',
    displayName: 'Game Clock',
    stateKeys: ['clock'],
    actionFields: {
        advance: ['amount', 'unit', 'note'],
        set: ['day', 'time'],
        show: [],
        history: [],
    },
    description: 'The in-world date and time for this chat. Call show to find out what day or hour it is before describing a scene, and advance whenever meaningful time passes — travel, rests, downtime.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['advance', 'set', 'show', 'history'],
                description: 'set jumps to an absolute day/time and clears the timeline.',
            },
            amount: { type: 'number', description: 'For advance: positive, e.g. 90 with unit "minutes".' },
            unit: { type: 'string', enum: Object.keys(UNITS), description: 'For advance. Required.' },
            day: { type: 'integer', description: 'For set: absolute day, 1 or more.' },
            time: { type: 'string', description: 'For set: HH:MM, e.g. "18:30".' },
            note: { type: 'string', description: 'What happened. Recorded in the timeline.' },
        },
        required: ['action'],
    },
    action: async (args) => transaction(READ_ONLY.has(args.action), (state) => {
        const clock = clockOf(state);

        switch (args.action) {
            case 'advance': {
                const minutes = toMinutes(args);
                const before = render(clock);
                const absolute = clock.day * MINUTES_PER_DAY + clock.minute + minutes;
                clock.day = Math.floor(absolute / MINUTES_PER_DAY);
                clock.minute = absolute % MINUTES_PER_DAY;

                const elapsed = minutes >= MINUTES_PER_DAY
                    ? `${(minutes / MINUTES_PER_DAY).toFixed(minutes % MINUTES_PER_DAY ? 1 : 0)} day(s)`
                    : minutes >= 60
                        ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
                        : `${minutes}m`;

                clock.log.push({ day: clock.day, minute: clock.minute, elapsed, note: args.note?.trim() || null });
                if (clock.log.length > 100) clock.log.shift();

                return `${elapsed} passes.\n${before} → ${render(clock)}${args.note ? `\n${args.note.trim()}` : ''}`;
            }

            case 'set': {
                const has = field => args[field] !== undefined && args[field] !== null;
                if (!has('day') && !has('time')) {
                    throw new ToolError('"set" needs at least one of "day" or "time".');
                }

                if (has('day')) {
                    if (!Number.isInteger(args.day) || args.day < 1) {
                        throw new ToolError(`"day" must be a whole number of 1 or more, got ${JSON.stringify(args.day)}.`);
                    }
                    clock.day = args.day;
                }
                if (has('time')) {
                    const match = typeof args.time === 'string' && /^(\d{1,2}):(\d{2})$/.exec(args.time.trim());
                    if (!match) {
                        throw new ToolError(`"time" must be HH:MM on a 24-hour clock, got ${JSON.stringify(args.time)}.`);
                    }
                    const hours = Number(match[1]);
                    const mins = Number(match[2]);
                    if (hours > 23 || mins > 59) {
                        throw new ToolError(`"${args.time}" is not a valid 24-hour time.`);
                    }
                    clock.minute = hours * 60 + mins;
                }

                const dropped = clock.log.length;
                clock.log = [];
                return `Clock set: ${render(clock)}${dropped ? ` (timeline cleared, ${dropped} entr${dropped === 1 ? 'y' : 'ies'} dropped)` : ''}`;
            }

            case 'show':
                return render(clock);

            case 'history': {
                if (!clock.log.length) {
                    return 'No time has been advanced in this chat yet.';
                }
                return clock.log
                    .map(e => `Day ${e.day} ${String(Math.floor(e.minute / 60)).padStart(2, '0')}:${String(e.minute % 60).padStart(2, '0')} (+${e.elapsed})${e.note ? ` — ${e.note}` : ''}`)
                    .join('\n');
            }

            default:
                throw new ToolError(`Unknown action "${args.action}".`);
        }
    }),
};
