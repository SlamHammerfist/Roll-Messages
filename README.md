# Roll Messages

Lets the GM attach plain-text or enriched-HTML notes to rolls with standard Active Effect changes.
The notes appear in a **Messages** box in the roll dialog whenever a matching effect is active on
the rolling actor. Bonus names in a note can be clicked to add that bonus to the roll.

This is the hub. It works with any game system but does nothing on its own: install the module
for your system alongside it.

| System | Module |
| --- | --- |
| D&D 5e | Roll Messages for D&D 5e (`roll-messages-dnd5e`) |

## Adding a message

Add a change to any active effect on the actor, or on an item that transfers its effects to it:

| Field | Value |
| --- | --- |
| Key | `flags.roll-messages.<type>` |
| Change type | Any. **Custom** keeps the actor's data untouched. |
| Value | Plain text or HTML. Enrichers such as `@UUID[...]` and `[[/r 1d4]]` work. |

The roll types, and the tags you can add after them to narrow a message down, come from the
system module (for D&D 5e, e.g. `flags.roll-messages.save.dex` or `flags.roll-messages.check.ste`).
A message shows only when the roll has every tag. `all` matches every roll.

## Clickable bonuses

Write `@Bonus[formula]{Name}` in a message to show a clickable name. Clicking it adds the bonus to
the roll, and clicking again takes it out. The name is highlighted while the bonus is in.
`@Bonus[1d4]` with no name uses the effect's name.

## Writing a system module

Register with the hub when it is ready. Everything except `id`, `hooks` and `describe` is optional.

```js
Hooks.once("rollMessages.ready", api => {
  api.registerSystem({
    // Only used when game.system.id matches.
    id: "mysystem",

    // Render hooks for the roll dialogs. Each must pass (app, element).
    hooks: ["renderMyRollDialog"],

    // What the dialog is rolling, or null to show nothing.
    describe(app, element) {
      return {
        actor: app.actor,
        type: "save",                      // matched against the first part of the key
        tags: ["reflex"],                  // matched against the rest
        aliases: { ref: "save" },          // other spellings of a type
        rollData: app.actor.getRollData()  // for inline rolls; this is the default
      };
    },

    // Where the Messages box goes. Default: above the dialog's buttons.
    insert(app, element, box) {
      element.querySelector(".roll-options").after(box);
    },

    // How a clicked bonus is added. formulaFieldBonus handles a text formula field.
    // For anything else, supply { has(app, element, bonus), toggle(app, element, bonus),
    // available(app, element) }, where bonus is { formula, label, term }.
    bonus: api.formulaFieldBonus(element => element.querySelector("input[name='bonus']")),

    // Extra messages for systems that don't keep effects as Active Effects.
    // Return [{ name, value, key, id, relativeTo }], key being e.g. "save.reflex".
    collect(actor, roll) {
      return [];
    },

    // Return false to hide a message for this roll, e.g. when the change's own conditions fail.
    // message.effect and message.change are the effect and change the message came from.
    condition(message, roll) {
      return true;
    }
  });
});
```

The hub is also at `game.modules.get("roll-messages").api` and `RollMessages` once Foundry has
initialised. Override the box colours with the `--rm-accent` and `--rm-active` CSS variables on
`.rm-messages`.

## Requirements

- Foundry VTT v14
- A Roll Messages system module for your game system
