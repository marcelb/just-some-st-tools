export function installContext() {
    const metadata = {};
    let saveCount = 0;

    globalThis.SillyTavern = {
        getContext: () => ({
            chatMetadata: metadata,
            saveMetadata: async () => { saveCount++; },
            registerFunctionTool: () => {},
            unregisterFunctionTool: () => {},
        }),
    };

    return {
        metadata,
        get saveCount() { return saveCount; },
    };
}

export function removeContext() {
    delete globalThis.SillyTavern;
}

export async function run(tool, args) {
    return tool.action(args);
}
