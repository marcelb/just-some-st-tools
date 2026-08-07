# just-some-st-tools

A SillyTavern extension that registers tabletop RPG function tools: dice, combat tracking,
keyed notes, random tables, and an in-world clock.

## Install

Extensions → Install extension → paste this repo's URL.

Function calling has to be on, or nothing here is ever reached: use a Chat Completion
backend that supports tools, and tick **Enable function calling** in the API settings.
The tools register as `rpg_roll_dice`, `rpg_combat_tracker`, `rpg_notes`,
`rpg_random_table` and `rpg_game_clock`.

## Telling the model to use them

Tool descriptions say what each tool does once the model has decided to call something.
They do not create the habit. A roleplay model will happily narrate *"you swing and hit
for 8"* without ever rolling. Put something like this in the system prompt or Author's
Note:

```
You have rpg_ tools for dice, combat, notes, random tables and the in-world clock.
Never state a die result, hit point total, or the current date that you did not get
back from a tool call, call the tool instead and use what it returns.
Resolve every roll with rpg_roll_dice, including attacks, saves and damage.
During a fight keep rpg_combat_tracker current: add every creature at the start,
apply damage and healing as they happen, and call status first for every round.
Batch your calls, one call with every creature or every target, not one per name.
```

## What persists

State lives in the chat's metadata under `justSomeStTools`, so it follows the chat and
nothing else. A new chat for the same campaign starts empty.

## Local test harness

The tools can be tested without launching SillyTavern:

```
npm install
npm run dev      # http://localhost:4173
```
