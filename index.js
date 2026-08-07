import { MODULE_NAME, PREFIX, TOOLS, safeAction } from './lib/registry.js';

function register() {
    if (typeof SillyTavern === 'undefined' || typeof SillyTavern.getContext !== 'function') {
        console.error(`[${MODULE_NAME}] SillyTavern global not available at load; nothing registered.`);
        return;
    }

    const context = SillyTavern.getContext();

    if (typeof context.registerFunctionTool !== 'function') {
        console.warn(`[${MODULE_NAME}] This SillyTavern build has no function-tool API; nothing registered.`);
        return;
    }

    for (const tool of TOOLS) {
        const name = `${PREFIX}${tool.name}`;
        try {
            context.unregisterFunctionTool?.(name);
            context.registerFunctionTool({
                name,
                displayName: tool.displayName,
                description: tool.description,
                parameters: tool.parameters,
                action: safeAction(tool),
                formatMessage: () => `${tool.displayName}…`,
            });
        } catch (error) {
            console.error(`[${MODULE_NAME}] failed to register ${name}:`, error);
        }
    }

    console.log(`[${MODULE_NAME}] registered ${TOOLS.length} tools: ${TOOLS.map(t => PREFIX + t.name).join(', ')}`);
}

try {
    register();
} catch (error) {
    console.error(`[${MODULE_NAME}] registration failed:`, error);
}
