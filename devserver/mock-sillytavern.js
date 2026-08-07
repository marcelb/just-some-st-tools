/**
 * In-memory stand-in for the SillyTavern host, so the tools can be exercised
 * without launching ST. Nothing here ships to users — it exists only to give
 * lib/state.js the `chatMetadata` + `saveMetadata` surface it expects.
 *
 * Chat switching is deliberately exposed: the tools persist into per-chat
 * metadata, and switching chats is the fastest way to see what that means.
 */

const chats = new Map();
let currentChatId = null;
let saveCount = 0;

function ensure(id) {
    if (!chats.has(id)) {
        chats.set(id, {});
    }
    return chats.get(id);
}

export function listChats() {
    return [...chats.keys()];
}

export function getCurrentChatId() {
    return currentChatId;
}

export function switchChat(id) {
    if (typeof id !== 'string' || !id.trim()) {
        throw new Error('Chat id must be a non-empty string.');
    }
    currentChatId = id.trim();
    ensure(currentChatId);
    return currentChatId;
}

export function getMetadata(id = currentChatId) {
    return ensure(id);
}

export function resetChat(id = currentChatId) {
    chats.set(id, {});
    return chats.get(id);
}

export function deleteChat(id) {
    if (id === currentChatId) {
        throw new Error('Cannot delete the chat that is currently open.');
    }
    return chats.delete(id);
}

export function getSaveCount() {
    return saveCount;
}

export function install() {
    switchChat(currentChatId ?? 'campaign-chat-1');

    globalThis.SillyTavern = {
        getContext() {
            return {
                chatMetadata: ensure(currentChatId),
                chatId: currentChatId,
                saveMetadata() {
                    saveCount++;
                },
                saveMetadataDebounced() {
                    saveCount++;
                },
                registerFunctionTool() {},
                unregisterFunctionTool() {},
            };
        },
    };
}
