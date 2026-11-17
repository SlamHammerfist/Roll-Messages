/**
 * Roll Messages (hub)
 *
 * Shows GM-written notes in a roll dialog whenever a matching Active Effect is active on the
 * rolling actor. This module knows nothing about any game system: it finds the messages, matches
 * them against a roll, enriches them, draws the Messages box and runs the clickable bonuses.
 * A system module (roll-messages-dnd5e, ...) tells it when a roll dialog opens, what kind of roll
 * it is, where the box goes and how a bonus is added.
 *
 * Change key:   flags.roll-messages.<type>[.<tag>...]
 *               The system module decides the types and tags (e.g. dnd5e: save.dex, check.ste).
 *               "all" matches every roll.
 * Change value: plain text or HTML. Enrichers work, and @Bonus[1d4]{Bless} becomes a clickable
 *               name that adds or removes the bonus. Without {Name} the effect's name is used.
 *
 * System modules register like this:
 *
 *   Hooks.once("rollMessages.ready", api => api.registerSystem({
 *     id: "dnd5e",                                // Only used when game.system.id matches.
 *     hooks: ["renderRollConfigurationDialog"],   // Render hooks that pass (app, element).
 *     describe(app, element) {                    // What is being rolled, or null to skip.
 *       return { actor, type: "save", tags: ["dex"], aliases: { init: "initiative" } };
 *     },
 *     insert(app, element, box) { ... },          // Optional. Put the box in the dialog.
 *     bonus: api.formulaFieldBonus(element => element.querySelector("input[name=...]")),
 *     collect(actor, roll) { ... },               // Optional. Extra message sources.
 *     condition(message, roll) { ... }            // Optional. false hides a message, e.g. when
 *                                                 // the change's own conditions fail for this roll.
 *   }));
 */

const MODULE = "roll-messages";

/** Effect change key prefix. */
const PREFIX = `flags.${MODULE}.`;

/** Bonus link syntax: @Bonus[formula] or @Bonus[formula]{Name}. */
const BONUS_PATTERN = /@Bonus\[([^\]]+)\](?:\{([^}]+)\})?/gi;

/** Registered systems, keyed by system id. */
const systems = new Map();

/** Render hooks already listened to, so a hook shared by two registrations is only added once. */
const listening = new Set();

/** Enriched HTML per dialog, keyed by message, so re-renders don't enrich again. */
const enrichedCache = new WeakMap();

/* -------------------------------------------- */
/*  API                                         */
/* -------------------------------------------- */

/**
 * @typedef {object} RollInfo
 * @property {Actor} actor             The actor making the roll.
 * @property {string} type             Roll type, e.g. "attack" or "save".
 * @property {Iterable<string>} [tags] Words a message key can narrow on, e.g. "dex".
 * @property {Record<string,string>} [aliases]  Other spellings of types, e.g. { init: "initiative" }.
 * @property {object} [rollData]       Data for enriching inline rolls. Defaults to actor.getRollData().
 */

/**
 * @typedef {object} Message
 * @property {string} name          Shown above the message, usually the effect's name.
 * @property {string} value         The raw message.
 * @property {string} key           The key after the prefix, e.g. "save.dex".
 * @property {string} id            Stable id for caching, e.g. the effect's uuid.
 * @property {Document} [relativeTo]  Document links in the message resolve against.
 * @property {ActiveEffect} [effect]  The effect the message is written on.
 * @property {object} [change]        The effect change holding the message.
 */

/**
 * @typedef {object} BonusHandler
 * @property {(app, element, bonus) => boolean} has     Is this bonus in the roll already?
 * @property {(app, element, bonus) => void} toggle     Add it, or take it out if it is in.
 * @property {(app, element) => boolean} [available]    Can bonuses be added right now?
 */

/**
 * @typedef {object} Bonus
 * @property {string} formula  e.g. "1d4".
 * @property {string} label    e.g. "Bless". Safe to use as a roll label.
 * @property {string} term     formula with its label, e.g. "1d4[Bless]".
 */

/**
 * @typedef {object} SystemConfig
 * @property {string} id                         Game system id.
 * @property {string[]} hooks                    Render hooks that pass (app, element).
 * @property {(app, element) => RollInfo|null} describe
 * @property {(app, element, box: HTMLElement) => void} [insert]
 * @property {BonusHandler} [bonus]
 * @property {(actor: Actor, roll: RollInfo) => Message[]} [collect]
 * @property {(message: Message, roll: RollInfo) => boolean} [condition]
 */

const api = {
  /** Change key prefix, "flags.roll-messages.". */
  PREFIX,

  /**
   * Register a game system. Only the registration for the running system is used.
   * @param {SystemConfig} config
   */
  registerSystem(config) {
    if ( !config?.id || (typeof config.describe !== "function") ) {
      throw new Error("Roll Messages | registerSystem needs an id and a describe function.");
    }
    systems.set(config.id, config);
    if ( config.id !== game.system.id ) return;
    for ( const hook of config.hooks ?? [] ) {
      if ( listening.has(hook) ) continue;
      listening.add(hook);
      Hooks.on(hook, (app, element) => onRender(hook, app, element));
    }
  },

  /** The registration for the running system, if any. */
  get system() {
    return systems.get(game.system.id) ?? null;
  },

  /**
   * Messages from Active Effects on the actor that match a roll.
   * @param {RollInfo} roll
   * @returns {Message[]}
   */
  findMessages(roll) {
    return findMessages(roll, api.system);
  },

  /**
   * A ready-made bonus handler for dialogs with a text formula field, such as a situational bonus.
   * Bonuses are added as "formula[Label]" terms joined with " + ".
   * @param {(element: HTMLElement, app) => HTMLInputElement|null} getInput
   * @returns {BonusHandler}
   */
  formulaFieldBonus(getInput) {
    return {
      available: (app, element) => !!getInput(element, app),
      has(app, element, bonus) {
        const input = getInput(element, app);
        return !!input && splitTerms(input.value).some(t => normalise(t) === normalise(bonus.term));
      },
      toggle(app, element, bonus) {
        const input = getInput(element, app);
        if ( !input ) return;
        const terms = splitTerms(input.value);
        const index = terms.findIndex(t => normalise(t) === normalise(bonus.term));
        if ( index >= 0 ) terms.splice(index, 1);
        else terms.push(bonus.term);
        input.value = terms.join(" + ");
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
  },

  /** Split a formula on top-level "+" signs. */
  splitTerms,

  /** Re-check which bonus links are on, e.g. after the system changed the bonus some other way. */
  refreshBonuses(app, element) {
    syncBonusLinks(app, element ?? app?.element);
  }
};

Hooks.once("init", () => {
  game.modules.get(MODULE).api = api;
  globalThis.RollMessages = api;
});

Hooks.once("setup", () => {
  /**
   * Fires once the hub is ready for system modules to register.
   * @param {object} api
   */
  Hooks.callAll("rollMessages.ready", api);
});

Hooks.once("ready", () => {
  if ( !systems.has(game.system.id) ) {
    console.info(`Roll Messages | No system module for "${game.system.id}" is active, so no messages will show.`);
  }
});

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

/**
 * A registered render hook fired.
 * @param {string} hook
 * @param {Application} app
 * @param {HTMLElement} element
 */
function onRender(hook, app, element) {
  const system = api.system;
  if ( !system?.hooks?.includes(hook) ) return;
  element = element instanceof HTMLElement ? element : (element?.[0] ?? app?.element);
  if ( !(element instanceof HTMLElement) ) return;
  decorate(system, app, element).catch(err => console.warn("Roll Messages | Could not show roll messages.", err));
}

/**
 * Add (or refresh) the Messages box in a roll dialog. Dialogs often re-render only part of
 * themselves, so if the box is still there with the same messages only the bonus links are updated.
 * @param {SystemConfig} system
 * @param {Application} app
 * @param {HTMLElement} element
 */
async function decorate(system, app, element) {
  const roll = system.describe(app, element);
  const messages = roll?.actor ? findMessages(roll, system) : [];
  const signature = messages.map(m => `${m.id}|${m.value}`).join("\n");

  const existing = element.querySelector(".rm-messages");
  if ( existing?.dataset.signature === signature ) {
    syncBonusLinks(app, element);
    return;
  }
  if ( !messages.length ) {
    existing?.remove();
    return;
  }

  const box = await buildBox(app, roll, messages);
  box.dataset.signature = signature;

  // Another render may have added one while the enrichment was running.
  element.querySelector(".rm-messages")?.remove();
  if ( system.insert ) system.insert(app, element, box);
  else defaultInsert(element, box);
  if ( !box.isConnected ) return;

  box.addEventListener("click", event => {
    const link = event.target.closest(".rm-bonus");
    if ( !link || !system.bonus ) return;
    event.preventDefault();
    event.stopPropagation();
    system.bonus.toggle(app, element, bonusFromLink(link));
    syncBonusLinks(app, element);
  });
  syncBonusLinks(app, element);
  app.setPosition?.({ height: "auto" });
}

/**
 * Put the box above the dialog's buttons, or at the end of its form.
 * @param {HTMLElement} element
 * @param {HTMLElement} box
 */
function defaultInsert(element, box) {
  const buttons = element.querySelector(".form-footer, footer, .dialog-buttons");
  if ( buttons ) buttons.before(box);
  else (element.querySelector("form, .window-content") ?? element).append(box);
}

/**
 * Build the box holding every matching message.
 * @param {Application} app
 * @param {RollInfo} roll
 * @param {Message[]} messages
 * @returns {Promise<HTMLFieldSetElement>}
 */
async function buildBox(app, roll, messages) {
  let cache = enrichedCache.get(app);
  if ( !cache ) enrichedCache.set(app, cache = new Map());
  const TextEditor = foundry.applications.ux.TextEditor.implementation;
  const rollData = roll.rollData ?? roll.actor.getRollData?.() ?? {};

  const box = document.createElement("fieldset");
  box.className = "rm-messages";
  const legend = document.createElement("legend");
  legend.textContent = game.i18n.has("ROLL_MESSAGES.Legend") ? game.i18n.localize("ROLL_MESSAGES.Legend") : "Messages";
  box.append(legend);

  for ( const message of messages ) {
    const key = `${message.id}|${message.value}`;
    let html = cache.get(key);
    if ( html === undefined ) {
      const withLinks = message.value.replace(BONUS_PATTERN,
        (match, formula, name) => bonusLink(formula, name ?? message.name));
      html = await TextEditor.enrichHTML(withLinks, {
        rollData, relativeTo: message.relativeTo, secrets: roll.actor.isOwner
      });
      cache.set(key, html);
    }
    const row = document.createElement("div");
    row.className = "rm-message";
    const body = document.createElement("div");
    body.className = "rm-message-body";
    body.innerHTML = html;
    // A bonus link already showing the effect's name stands in for the name header.
    const label = cleanLabel(message.name);
    const named = [...body.querySelectorAll(".rm-bonus")].some(a => a.dataset.label === label);
    if ( !named ) {
      const source = document.createElement("span");
      source.className = "rm-message-source";
      source.textContent = message.name;
      row.append(source);
    }
    row.append(body);
    box.append(row);
  }
  return box;
}

/* -------------------------------------------- */
/*  Bonus links                                 */
/* -------------------------------------------- */

/**
 * The HTML for a clickable bonus name.
 * @param {string} formula  Bonus to add, e.g. "1d4".
 * @param {string} name     Text to show, also used as the roll label.
 * @returns {string}
 */
function bonusLink(formula, name) {
  const esc = foundry.utils.escapeHTML;
  formula = formula.trim();
  const label = cleanLabel(name);
  return `<a class="rm-bonus" data-formula="${esc(formula)}" data-label="${esc(label)}" data-tooltip="${esc(formula)}">`
    + `<i class="fa-solid fa-plus" inert></i> ${esc(String(name))}</a>`;
}

/**
 * The bonus a link stands for.
 * @param {HTMLElement} link
 * @returns {Bonus}
 */
function bonusFromLink(link) {
  const formula = link.dataset.formula ?? "";
  const label = link.dataset.label ?? "";
  return { formula, label, term: label ? `${formula}[${label}]` : formula };
}

/**
 * Mark each bonus link that is currently in the roll, and grey them out if the system can't
 * add bonuses to this dialog.
 * @param {Application} app
 * @param {HTMLElement} element
 */
function syncBonusLinks(app, element) {
  const links = element?.querySelectorAll(".rm-bonus") ?? [];
  if ( !links.length ) return;
  const handler = api.system?.bonus;
  const available = !!handler && (handler.available?.(app, element) ?? true);
  for ( const link of links ) {
    link.classList.toggle("disabled", !available);
    link.classList.toggle("active", available && handler.has(app, element, bonusFromLink(link)));
  }
}

/** Strip characters that would break a roll label. */
function cleanLabel(label) {
  return String(label ?? "").replace(/[[\]{}()]/g, "").trim();
}

/**
 * Split a formula on top-level "+" signs. "1d4[Bless] + (2 + 1)" -> ["1d4[Bless]", "(2 + 1)"].
 * @param {string} formula
 * @returns {string[]}
 */
function splitTerms(formula) {
  const out = [];
  let depth = 0;
  let current = "";
  for ( const ch of String(formula ?? "") ) {
    if ( "([{".includes(ch) ) depth++;
    else if ( ")]}".includes(ch) ) depth--;
    if ( (ch === "+") && (depth === 0) ) {
      if ( current.trim() ) out.push(current.trim());
      current = "";
    }
    else current += ch;
  }
  if ( current.trim() ) out.push(current.trim());
  return out;
}

/** Compare formulas ignoring spaces and case. */
function normalise(formula) {
  return String(formula).replace(/\s+/g, "").toLowerCase();
}

/* -------------------------------------------- */
/*  Finding messages                            */
/* -------------------------------------------- */

/**
 * Every message that matches a roll: from the actor's Active Effects, plus any the system adds.
 * @param {RollInfo} roll
 * @param {SystemConfig|null} system
 * @returns {Message[]}
 */
function findMessages(roll, system) {
  const candidates = [...effectMessages(roll.actor)];
  try {
    candidates.push(...(system?.collect?.(roll.actor, roll) ?? []));
  } catch(err) {
    console.warn("Roll Messages | The system module could not collect messages.", err);
  }
  const tags = new Set(Array.from(roll.tags ?? [], t => String(t).toLowerCase()));
  const type = String(roll.type).toLowerCase();
  const aliases = Object.fromEntries(Object.entries(roll.aliases ?? {})
    .map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  return candidates.filter(m => m.value && matches(m.key, type, tags, aliases) && passes(m, roll, system));
}

/**
 * Does the system let this message show for this roll?
 * @param {Message} message
 * @param {RollInfo} roll
 * @param {SystemConfig|null} system
 * @returns {boolean}
 */
function passes(message, roll, system) {
  if ( !system?.condition ) return true;
  try {
    return system.condition(message, roll) !== false;
  } catch(err) {
    console.warn("Roll Messages | The system module could not check a message's conditions.", err);
    return true;
  }
}

/**
 * Messages written on the actor's active effects.
 * @param {Actor} actor
 * @returns {Message[]}
 */
function effectMessages(actor) {
  const out = [];
  const effects = actor.appliedEffects ?? Array.from(actor.allApplicableEffects?.() ?? []);
  for ( const effect of effects ) {
    if ( !effect || effect.disabled || effect.isSuppressed ) continue;
    for ( const change of effect.system?.changes ?? effect.changes ?? [] ) {
      const key = String(change.key ?? "").trim();
      if ( !key.toLowerCase().startsWith(PREFIX) ) continue;
      out.push({
        name: effect.name,
        value: String(change.value ?? "").trim(),
        key: key.slice(PREFIX.length),
        id: effect.uuid,
        relativeTo: effect,
        effect,
        change
      });
    }
  }
  return out;
}

/**
 * Does a key like "check.ste" apply to this roll?
 * @param {string} key
 * @param {string} type
 * @param {Set<string>} tags
 * @param {Record<string,string>} aliases
 * @returns {boolean}
 */
function matches(key, type, tags, aliases) {
  let [want, ...need] = String(key).toLowerCase().split(".").filter(Boolean);
  if ( !want ) return false;
  want = aliases[want] ?? want;
  if ( (want !== "all") && (want !== type) ) return false;
  return need.every(tag => tags.has(tag));
}
