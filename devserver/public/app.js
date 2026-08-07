const listEl = document.getElementById('tool-list');
const detailEl = document.getElementById('detail');
const stateDump = document.getElementById('state-dump');
const stateTitle = document.getElementById('state-title');
const stateScope = document.getElementById('state-scope');
const chatSelect = document.getElementById('chat-select');
const saveCountEl = document.getElementById('save-count');

let namespace = 'justSomeStTools';
let current = null;

async function api(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    return body;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/* ---------- schema → form ----------
 * Every node returns { el, read }. read() yields undefined when the user left
 * the control alone, so untouched optional fields never reach the tool.
 */

function labelFor(name, schema, required) {
    const wrap = el('div', 'field-head');
    const label = el('label', null, name ?? '');
    if (required) label.append(el('span', 'req', ' *'));
    const type = schema.enum ? 'enum' : (schema.type ?? 'any');
    label.append(el('span', 'type', ` ${type}`));
    wrap.append(label);
    return wrap;
}

function primitiveControl(schema, required) {
    if (Array.isArray(schema.enum)) {
        const select = el('select');
        // A required enum has no sensible empty state, so default to the first value.
        if (!required) select.append(new Option('— omit —', ''));
        for (const value of schema.enum) select.append(new Option(value, value));
        return { control: select, read: () => (select.value === '' ? undefined : select.value) };
    }

    if (schema.type === 'boolean') {
        const select = el('select');
        select.append(new Option('— omit —', ''), new Option('true', 'true'), new Option('false', 'false'));
        return { control: select, read: () => (select.value === '' ? undefined : select.value === 'true') };
    }

    const input = el('input');
    if (schema.type === 'integer' || schema.type === 'number') {
        input.type = 'number';
        if (schema.type === 'integer') input.step = '1';
        return {
            control: input,
            read: () => {
                const raw = input.value.trim();
                if (!raw) return undefined;
                const value = Number(raw);
                if (!Number.isFinite(value)) throw new Error(`"${input.dataset.path}" must be a number.`);
                return value;
            },
        };
    }

    input.type = 'text';
    return {
        control: input,
        read: () => (input.value.trim() === '' ? undefined : input.value),
    };
}

function buildNode(schema, { name, required = false, path = name ?? '' } = {}) {
    schema = schema ?? {};

    if (schema.type === 'object' && schema.properties) {
        return buildObject(schema, { name, required, path });
    }
    if (schema.type === 'array') {
        return buildArray(schema, { name, required, path });
    }

    const wrap = el('div', 'field');
    wrap.append(labelFor(name, schema, required));
    const { control, read } = primitiveControl(schema, required);
    control.dataset.path = path;
    wrap.append(control);
    if (schema.description) wrap.append(el('div', 'hint', schema.description));
    return { el: wrap, read };
}

function buildObject(schema, { name, required, path }) {
    const wrap = el('div', 'field');
    if (name) wrap.append(labelFor(name, schema, required));
    if (schema.description) wrap.append(el('div', 'hint', schema.description));

    const box = el('div', 'nested');
    const requiredProps = schema.required ?? [];
    const children = Object.entries(schema.properties ?? {}).map(([key, sub]) => {
        const node = buildNode(sub, {
            name: key,
            required: requiredProps.includes(key),
            path: path ? `${path}.${key}` : key,
        });
        box.append(node.el);
        return [key, node];
    });
    wrap.append(box);

    return {
        el: wrap,
        read() {
            const out = {};
            for (const [key, node] of children) {
                const value = node.read();
                if (value !== undefined) out[key] = value;
            }
            return Object.keys(out).length ? out : undefined;
        },
    };
}

function buildArray(schema, { name, required, path }) {
    const wrap = el('div', 'field');
    if (name) wrap.append(labelFor(name, schema, required));
    if (schema.description) wrap.append(el('div', 'hint', schema.description));

    const items = el('div', 'items');
    const nodes = [];
    wrap.append(items);

    const renumber = () => {
        [...items.children].forEach((row, index) => {
            row.querySelector('.item-index').textContent = `${name ?? 'item'}[${index}]`;
        });
    };

    const addItem = () => {
        const node = buildNode(schema.items ?? {}, { path: `${path}[]` });
        const row = el('div', 'item');
        const head = el('div', 'item-head');
        head.append(el('span', 'item-index', ''));
        const remove = el('button', 'link', 'remove');
        remove.type = 'button';
        remove.addEventListener('click', () => {
            row.remove();
            nodes.splice(nodes.indexOf(node), 1);
            renumber();
        });
        head.append(remove);
        row.append(head, node.el);
        items.append(row);
        nodes.push(node);
        renumber();
    };

    const add = el('button', 'add', `+ add ${name ?? 'item'}`);
    add.type = 'button';
    add.addEventListener('click', addItem);
    wrap.append(add);

    addItem();

    return {
        el: wrap,
        read() {
            const out = nodes.map(node => node.read()).filter(value => value !== undefined);
            return out.length ? out : undefined;
        },
    };
}

/* ---------- detail pane ---------- */

function showTool(tool, preselectAction) {
    current = tool;
    history.replaceState(null, '', `?tool=${tool.name}`);
    for (const button of listEl.querySelectorAll('button.tool')) {
        button.classList.toggle('active', button.dataset.name === tool.name);
    }

    detailEl.replaceChildren();
    detailEl.append(
        el('h2', 'tool-title', tool.displayName),
        el('div', 'meta', tool.registeredName),
        el('p', 'desc', tool.description),
    );

    const form = el('form');
    const props = tool.parameters?.properties ?? {};
    const required = tool.parameters?.required ?? [];
    const nodes = Object.entries(props).map(([name, schema]) => {
        const node = buildNode(schema, { name, required: required.includes(name), path: name });
        node.el.dataset.field = name;
        form.append(node.el);
        return [name, node];
    });

    // Tools that dispatch on an action only accept a subset of their parameters
    // per action; show that subset instead of the whole schema.
    const actionNode = nodes.find(([name]) => name === 'action')?.[1];
    const actionSelect = actionNode?.el.querySelector('select');
    const actionNote = el('div', 'action-note');
    if (tool.actionFields && actionSelect) {
        actionNode.el.after(actionNote);
        const applyVisibility = () => {
            const allowed = tool.actionFields[actionSelect.value];
            for (const [name, node] of nodes) {
                if (name === 'action') continue;
                node.el.hidden = allowed ? !allowed.includes(name) : false;
            }
            const shown = tool.actionFields[actionSelect.value];
            actionNote.textContent = shown && shown.length === 0
                ? `"${actionSelect.value}" takes no further parameters.`
                : '';
        };
        actionSelect.addEventListener('change', applyVisibility);
        if (preselectAction && tool.actionFields[preselectAction]) {
            actionSelect.value = preselectAction;
        }
        queueMicrotask(applyVisibility);
    }

    const rawWrap = el('details', 'raw');
    rawWrap.append(el('summary', null, 'Send raw JSON instead'));
    const rawBox = el('textarea');
    rawBox.placeholder = '{ "action": "list" }';
    rawWrap.append(rawBox);

    const actions = el('div', 'actions');
    const run = el('button', 'primary', 'Run');
    run.type = 'submit';
    const reset = el('button', null, 'Clear form');
    reset.type = 'button';
    reset.addEventListener('click', () => showTool(tool));
    const timing = el('span', 'muted');
    actions.append(run, reset, timing);

    const sent = el('pre', 'sent');
    sent.hidden = true;

    const output = el('pre', 'result', '(no result yet)');

    const schemaBox = el('details');
    schemaBox.append(el('summary', null, 'Parameter schema'), el('pre', null, JSON.stringify(tool.parameters, null, 2)));

    form.append(rawWrap, actions);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        output.classList.remove('bad');
        output.textContent = 'running…';
        timing.textContent = '';

        let args;
        try {
            if (rawBox.value.trim()) {
                args = JSON.parse(rawBox.value);
            } else {
                args = {};
                for (const [name, node] of nodes) {
                    if (node.el.hidden) continue;
                    const value = node.read();
                    if (value !== undefined) args[name] = value;
                }
            }
        } catch (error) {
            output.classList.add('bad');
            output.textContent = error.message;
            return;
        }

        sent.hidden = false;
        sent.textContent = `→ ${JSON.stringify(args)}`;

        try {
            const body = await api(`/api/run/${tool.name}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ args }),
            });
            output.classList.toggle('bad', body.result.startsWith('Error:'));
            output.textContent = body.result || '(empty result)';
            timing.textContent = `${body.ms} ms · chat ${body.chatId}`;
        } catch (error) {
            output.classList.add('bad');
            output.textContent = error.message;
        }
        await refreshState();
    });

    detailEl.append(form, sent, output, schemaBox);
    refreshState();
}

/* ---------- state pane ---------- */

async function refreshState() {
    const body = await api('/api/state');
    saveCountEl.textContent = `${body.saves} save(s)`;

    const all = body.metadata?.[namespace] ?? {};
    const keys = current?.stateKeys ?? [];
    const scoped = stateScope.value === 'tool';

    if (!scoped) {
        stateTitle.textContent = `${namespace} (all)`;
        stateDump.textContent = JSON.stringify(body.metadata, null, 2);
        return;
    }

    if (!keys.length) {
        stateTitle.textContent = current ? `${current.name} — stateless` : 'state';
        stateDump.textContent = 'This tool persists nothing.';
        return;
    }

    stateTitle.textContent = keys.map(k => `${namespace}.${k}`).join(', ');
    const slice = {};
    for (const key of keys) slice[key] = all[key] ?? null;
    stateDump.textContent = JSON.stringify(slice, null, 2);
}

stateScope.addEventListener('change', refreshState);
document.getElementById('state-refresh').addEventListener('click', refreshState);

/* ---------- chats ---------- */

async function refreshChats(data) {
    const body = data ?? await api('/api/chats');
    chatSelect.replaceChildren();
    for (const id of body.chats) {
        chatSelect.append(new Option(id, id, false, id === body.current));
    }
}

async function switchChat(id) {
    return api('/api/chats/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    });
}

chatSelect.addEventListener('change', async () => {
    await switchChat(chatSelect.value);
    await refreshState();
});

document.getElementById('chat-create').addEventListener('click', async () => {
    const input = document.getElementById('chat-new');
    if (!input.value.trim()) return;
    const body = await switchChat(input.value);
    input.value = '';
    await refreshChats(body);
    await refreshState();
});

document.getElementById('chat-reset').addEventListener('click', async () => {
    await api('/api/chats/reset', { method: 'POST' });
    await refreshState();
});

/* ---------- boot ---------- */

const catalog = await api('/api/tools');
namespace = catalog.namespace;

for (const tool of catalog.tools) {
    const button = el('button', 'tool', tool.displayName);
    button.dataset.name = tool.name;
    button.append(el('small', null, tool.registeredName));
    button.addEventListener('click', () => showTool(tool));
    listEl.append(button);
}

const params = new URLSearchParams(location.search);
const initial = catalog.tools.find(t => t.name === params.get('tool')) ?? catalog.tools[0];
if (initial) showTool(initial, params.get('action'));
await refreshChats();
await refreshState();
