# Changelog

## 2.0.1

- A message no longer shows its effect's name twice when an `@Bonus` link already shows that name.
- Messages in the Messages box are plain, without the tinted background and left border.

## 2.0.0

Rebuilt from scratch for Foundry VTT v14, and split into a system-free hub and system modules.

- An active effect change with the key `flags.roll-messages.<type>` shows its value, plain text or
  enriched HTML, in a Messages box in the roll dialog while the effect is active on the rolling
  actor. The system module decides the roll types and the tags that narrow a message down.
- `@Bonus[1d4]{Bless}` in a message is a clickable name that adds the bonus to the roll, and
  removes it again on a second click.
- `rollMessages.ready` hook and `registerSystem` API for system modules, with a ready-made
  handler for dialogs that take bonuses in a formula field.
