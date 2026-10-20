/* Hearthlight — SillyTavern extension
 * Tracks character stats / level, NPC relationships and quests per chat,
 * and shows them in a side panel with a modern chat theme.
 *
 * How it works:
 *  1. An extension prompt tells the model the current state and asks it to end every
 *     reply with a hidden comment:  <!--OGT:{"hp":-3,"xp":10,...}-->
 *  2. On MESSAGE_RECEIVED we parse + strip that tag, apply it to the state, and store
 *     a snapshot on the message (so swipes / deletes / branching stay consistent).
 *  3. The panel renders the state and lets you hand-edit anything.
 */
(() => {
    'use strict';

    const APP_NAME = 'Hearthlight';          // display name — change it here and in manifest.json
    const MODULE = 'hearthlight';            // settings / prompt key
    const LEGACY_MODULES = ['old_gregs_tavern']; // earlier names whose saved settings are migrated
    // accepts <!--OGT:{}-->, <ogt>{}</ogt>, [[OGT:{}]]
    // an unclosed <!--OGT: (reply cut off by the token limit) runs to the end of the text; parseTags repairs the JSON
    const TAG_RE = /<!--\s*OGT:?([\s\S]*?)(?:-->|$)|<ogt>([\s\S]*?)<\/ogt>|\[\[OGT:?([\s\S]*?)\]\]/gi;
    let lastStatus = 'No reply seen yet.';
    let parseIssues = { repaired: 0, failed: 0 }; // set by parseTags for the most recent reply
    const ctx = () => SillyTavern.getContext();

    const DEFAULT_SETTINGS = {
        enabled: true,
        inject: true,
        depth: 1,
        panelOpen: true,
        extraRules: '',
        toasts: true,
        theme: true,
        autoScan: true,
        trackRel: true,
        panelSide: 'left',
        xpMode: 'quests', // quests = only quest rewards give XP | mixed = quests + small ad-hoc XP | free = model decides
        xpMult: 1,
        pointsPerLevel: 2,
        skillMaxRank: 5,
        modelUnlockSkills: true,
        dice: true,
        rollMode: 'manual', // manual = the model asks, you click to roll | auto = the game rolls for you before each reply
        showRollMsg: false, // false = the result is passed to the narrator silently; true = posted as a visible [ROLL] message
        collapseMenu: true,
        luckRerolls: true,
        defaultGenre: 'fantasy', // pre-selected in the character creator
        trackParty: true,
        allyXp: true, // companions earn the same XP you do and level up
        autoEnemies: false, // the game plays enemy turns itself and tells the narrator the results
        allyControl: true, // you play your companions' turns yourself (action bar); the narrator doesn't decide their attacks
        // testing tools (GM tab → Testing); only take effect while testMode is on
        testMode: false,
        testInfiniteLuck: false,
        testDie: '', // '' = random, otherwise force every d20 to this number
        testNoDeliver: false, // roll results are not sent to the narrator (no API call)
    };

    // base XP by quest difficulty — the model only picks the difficulty, the extension pays out
    const DIFFICULTY = { trivial: 5, easy: 10, medium: 20, hard: 35, deadly: 60 };
    const MILESTONE_SHARE = 0.2, MILESTONE_MAX = 3, MIXED_CAP = 8;
    const normDiff = (d) => (DIFFICULTY[String(d || '').toLowerCase()] ? String(d).toLowerCase() : 'medium');

    /** Is Megumin Suite (or similar preset/NPC suite) installed? Used only for a hint in the UI. */
    const meguminDetected = () => Object.keys(ctx().extensionSettings || {}).some((k) => /megumin/i.test(k));

    const TIERS = [
        [-100, 'Hostile'], [-60, 'Distrustful'], [-25, 'Wary'], [0, 'Curious'],
        [15, 'Warming'], [40, 'Friendly'], [65, 'Trusted'], [85, 'Devoted'],
    ];

    let activeTab = 'character';
    let expandedRel = new Set();
    let editingChar = false;
    let expandedParty = new Set();

    // ───────────────────────── settings & state ─────────────────────────

    function settings() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE]) {
            // first run under this name: carry over settings saved under an earlier name (the old copy is left untouched)
            const legacy = LEGACY_MODULES.find((k) => extensionSettings[k]);
            extensionSettings[MODULE] = legacy ? JSON.parse(JSON.stringify(extensionSettings[legacy])) : {};
            if (legacy) saveSettings();
        }
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (extensionSettings[MODULE][k] === undefined) extensionSettings[MODULE][k] = v;
        }
        return extensionSettings[MODULE];
    }
    const saveSettings = () => ctx().saveSettingsDebounced();

    // Panel open/closed is remembered PER DEVICE (settings sync across devices, so a desktop-open panel used to cover the phone).
    const isMobile = () => window.matchMedia('(max-width: 800px)').matches;
    const panelKey = () => `ogt_panel_${isMobile() ? 'm' : 'd'}`;
    function panelOpen() {
        try { const v = localStorage.getItem(panelKey()); if (v !== null) return v === '1'; } catch (e) { /* storage blocked */ }
        return isMobile() ? false : settings().panelOpen !== false; // phones start with the panel closed
    }
    function setPanelOpen(v) {
        try { localStorage.setItem(panelKey(), v ? '1' : '0'); } catch (e) { /* storage blocked */ }
        render();
    }

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const xpNeeded = (lvl) => 30 * lvl;
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // Names that come from the model end up as object keys (relationships); never let one be a prototype key.
    const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    const safeName = (n, max = 40) => { const v = String(n ?? '').trim().slice(0, max); return v && !UNSAFE_KEYS.has(v.toLowerCase()) ? v : ''; };
    // Toast text may contain model-written names/titles and toastr can render HTML, so drop angle brackets.
    const notify = (type, msg, title = APP_NAME) => window.toastr?.[type]?.(String(msg).replace(/[<>]/g, ''), title);
    /** A URL that is safe to drop inside a CSS url('…'): web/data-image/relative only, every other character percent-encoded. */
    const cssUrl = (u) => {
        const v = String(u ?? '').trim();
        if (!/^(https?:\/\/|data:image\/|\/|[\w.%-]+\/)/i.test(v)) return '';
        return v.replace(/[^\w\-./:?=&%#@~+,;!*$]/g, (c) => (c.charCodeAt(0) < 128 ? '%' + c.charCodeAt(0).toString(16).padStart(2, '0') : encodeURIComponent(c)));
    };
    const tierOf = (v) => TIERS.reduce((t, [min, label]) => (v >= min ? label : t), TIERS[0][1]);

    function defaultState() {
        return {
            name: ctx().name1 || 'Adventurer',
            class: 'Adventurer',
            avatar: '',
            level: 1, xp: 0,
            hp: 25, hpMax: 25,
            mana: 5, manaMax: 5,
            scene: { region: '', location: '', time: '' },
            rel: {},
            quests: [],
            skills: [], skillPoints: 0,
            stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, statPoints: 0,
            inv: [], gold: 0, enemies: [], party: [],
            luck: 1, luckMax: 3,
            genre: 'fantasy',
        };
    }

    function getState() {
        const md = ctx().chatMetadata;
        if (!md) return defaultState();
        if (!md.ogt) md.ogt = defaultState();
        const o = md.ogt;
        // older saves / snapshots predate later features
        if (!Array.isArray(o.skills)) o.skills = [];
        if (!Number.isFinite(o.skillPoints)) o.skillPoints = 0;
        if (!o.stats) o.stats = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
        if (!Number.isFinite(o.statPoints)) o.statPoints = 0;
        if (!Array.isArray(o.inv)) o.inv = [];
        if (!Number.isFinite(o.gold)) o.gold = 0;
        if (!Array.isArray(o.enemies)) o.enemies = [];
        if (!Array.isArray(o.party)) o.party = [];
        if (!Array.isArray(o.log)) o.log = [];
        o.party.forEach((p) => {
            if (!Array.isArray(p.inv)) p.inv = [];
            if (!Array.isArray(p.abilities)) p.abilities = [];
            if (!Number.isFinite(p.baseAc)) p.baseAc = p.ac;
            if (!p.stats || typeof p.stats !== 'object') p.stats = defaultMemberStats();
            if (!Number.isFinite(p.xp)) p.xp = 0;
            if (!['balanced', 'aggressive', 'defensive', 'support'].includes(p.stance)) p.stance = 'balanced';
            if (!['', 'me', 'auto'].includes(p.control)) p.control = ''; // '' = follow the global setting
        });
        if (!Array.isArray(o.abilities)) { // casters start with one basic special attack the player can edit
            const special = (GENRES[o.genre] || GENRES.fantasy).terms.special;
            o.abilities = o.manaMax > 0 ? [normAbility({ name: special[0].toUpperCase() + special.slice(1), cost: 1, dmg: '1d8' }, o.level)] : [];
        }
        if (!Number.isFinite(o.luckMax)) o.luckMax = 3;
        if (!Number.isFinite(o.luck)) o.luck = 1;
        if (!o.genre) o.genre = 'fantasy'; // chats from before genres were fantasy
        return o;
    }

    // ───────────────────────── abilities, gear & combat ─────────────────────────
    const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
    const AB_NAME = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };
    const amod = (score) => Math.floor((num(score, 10) - 10) / 2);
    const fmtMod = (n) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);
    const profBonus = (lvl) => 2 + Math.floor((num(lvl, 1) - 1) / 4);
    // each skill is governed by an ability: skill bonus = rank + that ability's modifier
    const SKILL_ABILITY = {
        swordsmanship: 'str', archery: 'dex', stealth: 'dex', persuasion: 'cha', intimidation: 'cha', lore: 'int',
        survival: 'wis', alchemy: 'int', magic: 'int', smithing: 'str', medicine: 'wis', lockpicking: 'dex',
        deception: 'cha', performance: 'cha', insight: 'wis',
        // modern-day skills
        firearms: 'dex', brawling: 'str', athletics: 'str', driving: 'dex', hacking: 'int', investigation: 'int', mechanics: 'int', streetwise: 'cha',
        // slice-of-life / social skills
        charm: 'cha', leadership: 'cha', composure: 'con', academics: 'int', artistry: 'cha', tech_savvy: 'int',
    };
    const AB_FULL = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
    /** How an NPC feels about the player nudges social rolls: -4 (hostile) … +4 (devoted). Only applied when the check names the NPC. */
    function socialBonus(s, npc) {
        if (!npc) return 0;
        const q = slug(npc);
        const key = Object.keys(s.rel || {}).find((k) => slug(k) === q) || Object.keys(s.rel || {}).find((k) => slug(k).includes(q) || q.includes(slug(k)));
        return key ? clamp(Math.round(s.rel[key].value / 15), -4, 4) : 0;
    }
    const abilityOf = (sk) => sk.ability || SKILL_ABILITY[sk.id] || null;
    const skillBonus = (s, sk) => sk.rank + (abilityOf(sk) ? amod(s.stats?.[abilityOf(sk)]) : 0);

    const rnd = (n) => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % n; };
    const DIE_SIDES = [2, 3, 4, 6, 8, 10, 12, 20];
    /** "2d6+1" → {n, sides, plus}; dice count is capped by level so the model can't hand out absurd weapons. */
    function parseDice(spec, level = 1) {
        const m = String(spec || '').toLowerCase().replace(/\s/g, '').match(/^(\d{1,2})d(\d{1,3})([+-]\d{1,3})?$/);
        if (!m || !DIE_SIDES.includes(+m[2])) return null;
        const maxN = level >= 9 ? 4 : level >= 5 ? 3 : 2;
        return { n: clamp(+m[1], 1, maxN), sides: +m[2], plus: clamp(+(m[3] || 0), -5, 10) };
    }
    const diceStr = (d) => (d ? `${d.n}d${d.sides}${d.plus ? (d.plus > 0 ? '+' : '') + d.plus : ''}` : '');
    function rollDice(d, { crit = false, extra = 0 } = {}) {
        const n = crit ? d.n * 2 : d.n;
        const rolls = Array.from({ length: n }, () => 1 + rnd(d.sides));
        return { rolls, total: rolls.reduce((a, b) => a + b, 0) + d.plus + extra };
    }

    // ── items ──
    const ITEM_TYPES = ['weapon', 'armor', 'shield', 'potion', 'consumable', 'misc'];
    function normItem(it, level = 1) {
        const type = ITEM_TYPES.includes(it?.type) ? it.type : 'misc';
        const o = { id: slug(it.name), name: String(it.name).slice(0, 40), type, qty: clamp(Math.round(num(it.qty, 1)), 1, 99), desc: String(it.desc || '').slice(0, 120), equipped: false };
        if (type === 'weapon') {
            o.dmg = diceStr(parseDice(it.dmg, level) || parseDice('1d6'));
            o.ability = it.ability === 'dex' ? 'dex' : 'str';
            o.bonus = clamp(Math.round(num(it.bonus, 0)), 0, Math.min(3, 1 + Math.floor(level / 4)));
        } else if (type === 'armor') {
            o.ac = clamp(Math.round(num(it.ac, 11)), 11, 18);
            o.dexCap = it.dexCap == null || it.dexCap === '' ? (o.ac >= 16 ? 0 : o.ac >= 13 ? 2 : null) : clamp(Math.round(num(it.dexCap)), 0, 5);
        } else if (type === 'shield') {
            o.ac = clamp(Math.round(num(it.ac, 2)), 1, 3);
        } else if (type === 'potion' || type === 'consumable') {
            const h = parseDice(it.heal, level), m = parseDice(it.mana, level);
            if (h) o.heal = diceStr(h);
            if (m) o.mana = diceStr(m);
        }
        return o;
    }
    function addItem(s, it) {
        if (!it?.name || !slug(it.name)) return null;
        const n = normItem(it, s.level);
        const have = s.inv.find((x) => x.id === n.id && x.type === n.type);
        if (have) { have.qty = clamp(have.qty + n.qty, 1, 99); return have; }
        s.inv.push(n);
        return n;
    }
    function removeItem(s, name, qty = 1) {
        const q = slug(name || '');
        const it = s.inv.find((x) => x.id === q) || s.inv.find((x) => x.id.includes(q) || q.includes(x.id));
        if (!it) return null;
        it.qty -= Math.max(1, Math.round(num(qty, 1)));
        if (it.qty <= 0) { s.inv = s.inv.filter((x) => x !== it); }
        return it;
    }
    const equippedOf = (s, type) => s.inv.find((i) => i.type === type && i.equipped) || null;

    /** AC = armor base (10 unarmored) + DEX mod (capped by the armor) + shield. */
    function computeAC(s) {
        const armor = equippedOf(s, 'armor'), shield = equippedOf(s, 'shield');
        const dex = amod(s.stats?.dex);
        const dexPart = armor && armor.dexCap != null ? Math.min(dex, armor.dexCap) : dex;
        return (armor ? armor.ac : 10) + dexPart + (shield ? shield.ac : 0);
    }

    function attackProfile(s, spell = false) {
        const w = spell ? null : equippedOf(s, 'weapon');
        const ability = spell ? 'int' : (w?.ability || 'str');
        const magic = w?.bonus || 0;
        return { w, ability, magic, bonus: profBonus(s.level) + amod(s.stats?.[ability]) + magic };
    }

    // ── enemies (tracked by the game so HP is honest) ──
    function findEnemy(s, name) {
        const q = slug(name || '');
        if (!q) return null;
        const live = s.enemies.filter((e) => !e.defeated);
        return live.find((e) => e.id === q) || live.find((e) => e.id.includes(q) || q.includes(e.id)) || null;
    }
    function addEnemy(s, e) {
        if (!e?.name) return null;
        let name = String(e.name).slice(0, 30), n = 2;
        while (s.enemies.some((x) => x.name === name && !x.defeated)) name = `${String(e.name).slice(0, 26)} ${n++}`;
        const hp = clamp(Math.round(num(e.hp, 8)), 1, 250);
        const en = { id: slug(name), name, hp, hpMax: hp, ac: clamp(Math.round(num(e.ac, 12)), 5, 25), defeated: false };
        if (e.atk != null && Number.isFinite(+e.atk)) en.atk = clamp(Math.round(+e.atk), 0, 4 + s.level); // to-hit bonus
        const dd = parseDice(e.dmg, s.level);
        if (dd) en.dmg = diceStr(dd); // damage per hit, e.g. "1d6+1"
        s.enemies.push(en);
        return en;
    }

    // ───────────────────────── initiative & attack log ─────────────────────────
    // s.combat = { round, turn, order:[{id,name,kind,init}] } exists while a live enemy is on the roster. The game keeps the
    // order sorted and drops/adds combatants as HP changes; the narrator (or the Next-turn button) advances the turn.
    const LOG_MAX = 30;

    function combatants(s) {
        return [
            { id: 'player', name: s.name, kind: 'player', mod: amod(s.stats?.dex), alive: s.hp > 0 },
            ...s.party.map((p) => ({ id: `p:${p.id}`, name: p.name, kind: 'party', mod: amod(p.stats?.dex), alive: p.hp > 0 })),
            ...s.enemies.map((e) => ({ id: `e:${e.id}`, name: e.name, kind: 'enemy', mod: Math.floor((e.ac - 10) / 3), alive: !e.defeated })),
        ];
    }

    function syncInitiative(s) {
        if (!hasCombat(s) || !s.enemies.some((e) => !e.defeated)) { s.combat = null; return; }
        if (!s.combat) { s.combat = { round: 1, turn: 0, order: [] }; s.log = []; } // a new fight starts a fresh attack log
        const all = combatants(s).filter((c) => c.alive);
        const cur = s.combat.order[s.combat.turn]?.id;
        s.combat.order = s.combat.order.filter((o) => all.some((c) => c.id === o.id));
        for (const c of all) {
            const have = s.combat.order.find((o) => o.id === c.id);
            if (have) have.name = c.name;
            else s.combat.order.push({ id: c.id, name: c.name, kind: c.kind, init: d20() + c.mod });
        }
        s.combat.order.sort((a, b) => b.init - a.init);
        const i = s.combat.order.findIndex((o) => o.id === cur);
        s.combat.turn = i >= 0 ? i : clamp(s.combat.turn, 0, Math.max(0, s.combat.order.length - 1));
    }

    function nextTurn(s) {
        if (!s.combat?.order.length) return;
        s.combat.turn += 1;
        if (s.combat.turn >= s.combat.order.length) { s.combat.turn = 0; s.combat.round += 1; }
        const id = s.combat.order[s.combat.turn]?.id;
        if (id && s.combat.guard) delete s.combat.guard[id]; // a defensive stance lasts until that combatant's next turn
    }

    function logAttack(s, entry) {
        s.log = (s.log || []).concat({ round: s.combat?.round || 0, ...entry }).slice(-LOG_MAX);
    }

    // ── auto-play: the game takes enemy turns (and allies' when you don't control them) and reports one summary ──
    /** An enemy's attack bonus and damage dice; enemies the narrator registered without stats get a level-based default. */
    function enemyStats(s, e) {
        const lvl = s.level;
        const atk = Number.isFinite(e.atk) ? e.atk : 2 + Math.floor(lvl / 2) + (e.hpMax >= 30 ? 1 : 0);
        const dmg = e.dmg && parseDice(e.dmg, lvl) ? e.dmg : (lvl < 3 ? '1d6' : lvl < 6 ? '1d8' : '2d6');
        return { atk: clamp(atk, 0, 4 + lvl), dmg };
    }

    /** Player-side combatants that can still be hit. */
    const livingSide = (s) => [s.hp > 0 ? { ref: s, member: null } : null, ...s.party.filter((p) => p.hp > 0).map((p) => ({ ref: p, member: p }))].filter(Boolean);

    /** Mostly goes for the most wounded target, sometimes anyone — so fights aren't perfectly predictable. */
    function pickEnemyTarget(s) {
        const side = livingSide(s);
        if (!side.length) return null;
        if (rnd(100) < 35) return side[rnd(side.length)];
        return side.slice().sort((a, b) => a.ref.hp / a.ref.hpMax - b.ref.hp / b.ref.hpMax)[0];
    }

    function autoEnemyTurn(s, e) {
        const tgt = pickEnemyTarget(s);
        if (!tgt) return '';
        const st = enemyStats(s, e);
        return resolveDefend({ kind: 'defend', enemy: e.name, atk: st.atk, dmg: st.dmg, target: tgt.member?.name, adv: 0, mod: 0 }, { a: d20(), b: d20() }, s).text;
    }

    const avgDice = (spec, lvl) => { const d = parseDice(spec, lvl); return d ? d.n * (d.sides + 1) / 2 + d.plus : 0; };

    /** A companion the game plays, following its stance: aggressive hits hard, defensive guards when hurt, support heals early. */
    function autoAllyTurn(s, p) {
        const mana = genreOf(s).terms.mana.toLowerCase();
        const stance = p.stance || 'balanced';
        const healBelow = { aggressive: 0.25, balanced: 0.5, defensive: 0.5, support: 0.75 }[stance];
        const hurt = [s, ...s.party].filter((x) => x.hp > 0 && x.hp / x.hpMax < healBelow).sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax)[0];
        const heal = (p.abilities || []).find((a) => a.kind === 'heal' && p.mana >= a.cost);
        if (heal && hurt) {
            p.mana -= heal.cost;
            const before = hurt.hp;
            hurt.hp = Math.min(hurt.hpMax, hurt.hp + rollDice(parseDice(heal.dmg, p.level) || parseDice('1d8')).total);
            return `${p.name} used ${heal.name} on ${hurt === s ? s.name : hurt.name}: restored ${hurt.hp - before} HP (spent ${heal.cost} ${mana}).`;
        }
        if (stance === 'defensive' && p.hp / p.hpMax < 0.5 && s.combat && !s.combat.guard?.[`p:${p.id}`]) {
            s.combat.guard = { ...(s.combat.guard || {}), [`p:${p.id}`]: true };
            return `${p.name} takes a defensive stance — attacks against them have disadvantage until their next turn.`;
        }
        const foes = s.enemies.filter((e) => !e.defeated);
        const foe = foes.find((e) => e.id === p.focus) || foes.sort((a, b) => a.hp - b.hp)[0]; // the focus target if set, else the weakest
        if (!foe) return '';
        const known = (p.abilities || []).filter((a) => a.kind === 'attack' && p.mana >= a.cost).sort((a, b) => avgDice(b.dmg, p.level) - avgDice(a.dmg, p.level));
        // support keeps its mana for healing; aggressive always uses its strongest ability; others mix it in
        const useAbility = known.length && (stance === 'aggressive' || (stance === 'balanced' && rnd(2) === 0) || (stance === 'defensive' && rnd(3) === 0)
            || (stance === 'support' && !(p.abilities || []).some((a) => a.kind === 'heal')));
        const use = useAbility ? known[0] : null;
        return resolveAttack({ kind: 'attack', by: p.id, spell: !!use, dmg: use?.dmg, abilityName: use?.name, cost: use?.cost || 0, target: foe.name, ac: foe.ac, adv: 0, mod: 0 }, { a: d20(), b: d20() }, s).text;
    }

    /** Play every turn until it is one you control again (or the fight ends). Returns the result lines. */
    function runAutoTurns(s, { enemies = true } = {}) {
        const lines = [];
        for (let i = 0; i < 16; i++) {
            const c = s.combat;
            if (!c?.order.length || !s.enemies.some((e) => !e.defeated) || !livingSide(s).length) break;
            const o = c.order[c.turn];
            if (!o) break;
            if (o.kind === 'player') { if (s.hp > 0) break; }
            else if (o.kind === 'party') {
                const p = s.party.find((x) => `p:${x.id}` === o.id);
                if (p && p.hp > 0) {
                    if (isPlayed(p)) break;
                    lines.push(autoAllyTurn(s, p));
                }
            } else {
                if (!enemies) break; // enemy turns wait for the narrator unless auto-play is on
                const e = s.enemies.find((x) => `e:${x.id}` === o.id);
                if (e && !e.defeated) lines.push(autoEnemyTurn(s, e));
            }
            nextTurn(s);
        }
        return lines.filter(Boolean);
    }
    const autoTurnsText = (s, opts) => { const l = runAutoTurns(s, opts); return l.length ? `TURNS RESOLVED BY THE GAME: ${l.join(' ')}` : ''; };

    // ───────────────────────── party ─────────────────────────
    // Companions travel with the player. They have their own HP / mana / skills but no dice: the narrator plays them,
    // the game only keeps their numbers (via the "party" tag, or by hand in the Party tab).
    const PARTY_MAX = 6;
    const defaultMemberStats = () => ({ str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 });
    /** Narrator-supplied ability scores, clamped to a sane range; anything missing stays at the default. */
    function normMemberStats(st) {
        const out = defaultMemberStats();
        for (const a of ['str', 'dex', 'con', 'int', 'wis', 'cha']) if (st && Number.isFinite(+st[a])) out[a] = clamp(Math.round(+st[a]), 3, 20);
        return out;
    }

    /** Accepts [["Archery",3]], ["Archery"], [{name,rank}] and returns clean {name, rank} entries. */
    function normSkills(list) {
        const out = [];
        for (const k of [].concat(list || []).slice(0, 12)) {
            const name = String(Array.isArray(k) ? k[0] : typeof k === 'string' ? k : k?.name || '').trim().slice(0, 30);
            const rank = clamp(Math.round(num(Array.isArray(k) ? k[1] : k?.rank, 1)), 1, 10);
            if (name && !out.some((x) => x.name.toLowerCase() === name.toLowerCase())) out.push({ name, rank });
        }
        return out;
    }
    /** "Archery 3, Stealth 2" → skills (used by the edit box in the Party tab). */
    const parseSkillText = (t) => normSkills(String(t).split(',').map((x) => {
        const m = x.trim().match(/^(.*?)\s*(\d+)?$/);
        return [m[1], m[2] || 1];
    }));
    const skillText = (p) => p.skills.map((k) => `${k.name} ${k.rank}`).join(', ');

    function findMember(s, ref) {
        const q = slug(ref ?? '');
        if (!q) return null;
        return s.party.find((p) => p.id === q) || s.party.find((p) => p.id.includes(q) || q.includes(p.id)) || null;
    }
    function addMember(s, m) {
        if (!m?.name || s.party.length >= PARTY_MAX) return null;
        const name = String(m.name).trim().slice(0, 40), id = slug(name);
        if (!id || s.party.some((p) => p.id === id)) return null;
        const hpMax = clamp(Math.round(num(m.hpMax ?? m.hp, 20)), 1, 500);
        const manaMax = clamp(Math.round(num(m.manaMax ?? m.mana, 0)), 0, 200);
        const p = {
            id, name, class: String(m.class || 'Companion').slice(0, 30), level: clamp(Math.round(num(m.level, s.level)), 1, 20),
            hp: hpMax, hpMax, mana: manaMax, manaMax, ac: clamp(Math.round(num(m.ac, 12)), 5, 25), baseAc: clamp(Math.round(num(m.ac, 12)), 5, 25),
            skills: normSkills(m.skills), note: String(m.note || '').slice(0, 120), inv: [],
            stats: normMemberStats(m.stats), xp: 0, stance: 'balanced', control: '', focus: '',
        };
        p.abilities = [];
        for (const it of [].concat(m.inv || []).slice(0, 8)) addToBag(p.inv, it, s.level);
        for (const a of [].concat(m.abilities || []).slice(0, ABILITY_MAX)) addAbility(p, a);
        s.party.push(p);
        return p;
    }

    // ── abilities: named actions with a mana cost and a damage (or healing) dice, for the player and every companion ──
    const ABILITY_MAX = 6;
    function normAbility(a, level = 1) {
        const name = String(a?.name || '').trim().slice(0, 30);
        if (!name) return null;
        const kind = a?.kind === 'heal' ? 'heal' : 'attack';
        const dice = parseDice(a?.dmg ?? a?.heal, level) || parseDice('1d8', level);
        return { id: slug(name), name, kind, cost: clamp(Math.round(num(a?.cost, 1)), 0, 20), dmg: diceStr(dice), desc: String(a?.desc || '').slice(0, 100) };
    }
    function addAbility(owner, a) {
        const n = normAbility(a, owner.level);
        if (!n) return null;
        owner.abilities = owner.abilities || [];
        const i = owner.abilities.findIndex((x) => x.id === n.id);
        if (i >= 0) owner.abilities[i] = n;
        else if (owner.abilities.length < ABILITY_MAX) owner.abilities.push(n);
        else return null;
        return n;
    }
    /** 'player' → the sheet itself, otherwise a companion (both expose name, level, mana, hp, inv/abilities). */
    const ownerOf = (s, id) => (id === 'player' ? s : s.party.find((p) => p.id === id) || null);

    // ── shared gear: the player and each companion carry their own bag; items can be handed back and forth ──
    const BAG_MAX = 30; // distinct stacks a companion can carry (the player's pack is uncapped)
    /** 'player' → your pack, otherwise a party member's id. */
    const bagOf = (s, id) => (id === 'player' ? s.inv : s.party.find((p) => p.id === id)?.inv || null);
    const bagName = (s, id) => (id === 'player' ? s.name : s.party.find((p) => p.id === id)?.name || '?');

    function addToBag(bag, it, level, max = BAG_MAX) {
        if (!it?.name || !slug(it.name)) return null;
        const n = normItem(it, level);
        const have = bag.find((x) => x.id === n.id && x.type === n.type);
        if (have) { have.qty = clamp(have.qty + n.qty, 1, 99); return have; }
        if (bag.length >= max) return null;
        bag.push(n);
        return n;
    }
    function findInBag(bag, { id, type, name }) {
        const q = slug(name || id || '');
        return bag.find((x) => id && x.id === id && (!type || x.type === type)) || bag.find((x) => q && x.id === q)
            || bag.find((x) => q && (x.id.includes(q) || q.includes(x.id))) || null;
    }
    /** Move up to `qty` of an item between two bags. Returns {item, qty} or null if nothing could be moved. */
    function transferItem(s, { id, type, name, from, to, qty = 1 }) {
        const src = bagOf(s, from), dst = bagOf(s, to);
        if (!src || !dst || from === to) return null;
        const it = findInBag(src, { id, type, name });
        if (!it) return null;
        let n = clamp(Math.round(num(qty, 1)), 1, it.qty);
        const have = dst.find((x) => x.id === it.id && x.type === it.type);
        if (have) n = Math.min(n, 99 - have.qty);
        if (n <= 0) return null;
        const moved = addToBag(dst, { ...it, qty: n }, s.level, to === 'player' ? Infinity : BAG_MAX);
        if (!moved) return null;
        it.qty -= n;
        if (it.qty <= 0) src.splice(src.indexOf(it), 1);
        return { item: moved, qty: n };
    }
    const equippedIn = (bag, type) => bag.find((i) => i.type === type && i.equipped) || null;
    /** A companion's AC comes from what they wear: armor replaces their base AC, a shield adds to it. Call after anything that changes a bag. */
    function recalcParty(s) {
        for (const p of s.party) {
            const armor = equippedIn(p.inv, 'armor'), shield = equippedIn(p.inv, 'shield');
            if (!Number.isFinite(p.baseAc)) p.baseAc = p.ac;
            p.ac = clamp((armor ? armor.ac : p.baseAc) + (shield ? shield.ac : 0), 5, 25);
        }
    }

    /** A companion leaves: whatever they carried goes into the player's pack. Returns how many stacks moved. */
    function returnGear(s, p) {
        let n = 0;
        for (const it of p.inv || []) if (addToBag(s.inv, it, s.level, Infinity)) n++;
        p.inv = [];
        return n;
    }
    const itemsText = (bag) => bag.slice(0, 8).map((i) => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name)).join(', ');

    // ───────────────────────── skills ─────────────────────────
    // A new skill costs 1 point (rank 1). Raising rank r → r+1 costs r+1 points. Total to master (5) = 15.
    const rankUpCost = (rank) => rank + 1;
    // `base` = ranks granted for free (class / story); only ranks above it were paid for with points
    const tri = (n) => (n * (n + 1)) / 2;
    const spentOn = (sk) => tri(sk.rank) - tri(sk.base || 0);
    const RANK_NAMES = ['Untrained', 'Novice', 'Apprentice', 'Skilled', 'Expert', 'Master'];
    const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const PRESET_SKILLS = [
        ['Swordsmanship', 'Melee combat with blades.'], ['Archery', 'Bows, crossbows and thrown weapons.'],
        ['Stealth', 'Moving unseen and unheard, picking pockets.'], ['Persuasion', 'Convincing, bargaining, charm.'],
        ['Intimidation', 'Threats, presence, breaking morale.'], ['Lore', 'History, languages, arcane and religious knowledge.'],
        ['Survival', 'Tracking, foraging, navigation, weather.'], ['Alchemy', 'Potions, poisons and reagents.'],
        ['Magic', 'Channeling mana into spells.'], ['Smithing', 'Forging and repairing arms and armor.'],
        ['Medicine', 'Treating wounds and illness.'], ['Lockpicking', 'Locks, traps and mechanisms.'],
        ['Deception', 'Lying, bluffing, disguises and forgery.'], ['Performance', 'Music, oratory, acting and winning a crowd.'],
        ['Insight', 'Reading intent, spotting lies and moods.'],
    ];

    function addSkill(s, name, desc = '', { base = 0, ability = null } = {}) {
        const id = slug(name);
        if (!id || s.skills.some((k) => k.id === id)) return null;
        const sk = { id, name: String(name).slice(0, 40), desc: String(desc || '').slice(0, 160), rank: Math.max(1, base), base };
        if (ABILITIES.includes(ability)) sk.ability = ability;
        s.skills.push(sk);
        return sk;
    }

    // Saving rewrites the WHOLE chat file, so never do it more than once in a burst (replies, clicks and typing all land here).
    let saveTimer = null;
    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const c = ctx();
            try { (c.saveMetadata || c.saveChat)?.call(c); } catch (e) { console.warn(`[${MODULE}] save failed`, e); }
        }, 800);
    }

    // Snapshots exist so swipes/deletes can roll the tracker back. Keep them for recent replies plus a sparse
    // checkpoint trail instead of one per message — otherwise the chat file balloons on long chats.
    const SNAP_KEEP_RECENT = 60, SNAP_CHECKPOINT_EVERY = 25;
    function pruneSnapshots() {
        const chat = ctx().chat || [];
        const cutoff = chat.length - SNAP_KEEP_RECENT;
        for (let i = 0; i < cutoff; i++) {
            const x = chat[i].extra;
            if (x?.ogt_snap && i % SNAP_CHECKPOINT_EVERY !== 0) delete x.ogt_snap;
            if (x?.ogt_check?.pre) delete x.ogt_check.pre;
        }
    }
    function lastSnapIndex(chat) {
        for (let i = chat.length - 1; i >= 0; i--) if (chat[i].extra?.ogt_snap) return i;
        return -1;
    }

    function persist({ manual = false } = {}) {
        const c = ctx();
        const md = c.chatMetadata;
        if (!md) return;
        recalcParty(getState());
        syncInitiative(getState());
        if (manual) {
            // keep hand edits alive across swipe/delete resyncs
            md.ogt_base = clone(md.ogt);
            const i = lastSnapIndex(c.chat);
            if (i >= 0) c.chat[i].extra.ogt_snap = clone(md.ogt);
        }
        scheduleSave();
        refreshPrompt();
        render();
    }

    /** Rebuild live state from the newest message snapshot (optionally ignoring the last message). */
    function syncFromChat(excludeLast = false) {
        const c = ctx();
        const md = c.chatMetadata;
        if (!md) return;
        const end = excludeLast ? c.chat.length - 1 : c.chat.length;
        let at = -1;
        for (let i = end - 1; i >= 0; i--) if (c.chat[i].extra?.ogt_snap) { at = i; break; }
        md.ogt = at >= 0 ? clone(c.chat[at].extra.ogt_snap) : clone(md.ogt_base || defaultState());
        refreshPrompt();
        render();
    }

    // ───────────────────────── applying model updates ─────────────────────────

    /** +1 Luck (capped). Earned from quests, level-ups and rare inspired play. */
    function gainLuck(s, notes, why) {
        if (!settings().luckRerolls || s.luck >= s.luckMax) return;
        s.luck += 1;
        notes.push(['info', `🍀 +1 Luck (${why})`]);
    }

    /** Add XP (scaled by the XP multiplier unless raw) and process level-ups. */
    function gainXp(s, amount, notes, label = '') {
        const gained = Math.round(amount * num(settings().xpMult, 1));
        if (gained <= 0) return 0;
        s.xp += gained;
        notes.push(['info', `+${gained} XP${label ? ' — ' + label : ''}`]);
        if (settings().allyXp) for (const p of s.party || []) gainMemberXp(s, p, gained, notes); // companions share the experience
        while (s.xp >= xpNeeded(s.level)) {
            s.xp -= xpNeeded(s.level);
            s.level += 1;
            s.hpMax += Math.max(1, (s.growth?.hp ?? 5) + amod(s.stats?.con)); s.manaMax += s.growth?.mana ?? 2;
            s.hp = s.hpMax; s.mana = s.manaMax;
            const pts = Math.max(0, Math.round(num(settings().pointsPerLevel, 2)));
            s.skillPoints = (s.skillPoints || 0) + pts;
            gainLuck(s, notes, 'level up');
            const asi = s.level % 2 === 0; // an ability point every even level
            if (asi) s.statPoints = (s.statPoints || 0) + 1;
            notes.push(['success', `Level up! ${s.name} is now level ${s.level}.${pts ? ` +${pts} skill points.` : ''}${asi ? ' +1 ability point.' : ''}`]);
        }
        return gained;
    }

    /** Companions level on the same curve as the player. Each level: more HP/mana, a stronger best ability score, and a skill rank every other level. */
    function gainMemberXp(s, p, amount, notes) {
        p.xp = (p.xp || 0) + amount;
        while (p.level < 20 && p.xp >= xpNeeded(p.level)) {
            p.xp -= xpNeeded(p.level);
            p.level += 1;
            p.hpMax = clamp(p.hpMax + Math.max(1, 4 + amod(p.stats?.con)), 1, 500);
            if (p.manaMax > 0) p.manaMax = clamp(p.manaMax + 2, 0, 200);
            p.hp = p.hpMax; p.mana = p.manaMax;
            const top = Object.entries(p.stats || {}).sort((a, b) => b[1] - a[1])[0]; // the ability they lean on grows
            if (top && p.level % 2 === 0 && top[1] < 20) p.stats[top[0]] += 1;
            const grown = p.level % 2 === 0 && p.skills.length ? p.skills.slice().sort((a, b) => b.rank - a.rank)[0] : null;
            if (grown && grown.rank < num(settings().skillMaxRank, 5)) grown.rank += 1;
            notes.push(['success', `${p.name} reached level ${p.level}!${grown ? ` ${grown.name} is now rank ${grown.rank}.` : ''}`]);
        }
        if (p.level >= 20) p.xp = 0;
    }

    const questReward = (q) => num(q.xp, DIFFICULTY[normDiff(q.difficulty)]);

    /** Mark a quest done and pay its reward once (re-opening and re-completing never double-pays). */
    function completeQuest(s, q, notes) {
        if (q.status === 'done') return;
        q.status = 'done';
        notes.push(['success', `Quest complete: ${q.title}`]);
        if (!q.awarded) gainLuck(s, notes, 'quest complete');
        if (!q.awarded) {
            q.awarded = true;
            const rest = Math.max(0, questReward(q) - num(q.paid, 0));
            gainXp(s, rest, notes, q.title);
        }
    }

    function applyDelta(s, d) {
        const notes = [];
        if (typeof d !== 'object' || !d) return notes;

        // sanity limits on what a single reply can change, so a confused model can't wreck the sheet
        const text = (v, n) => String(v).slice(0, n);
        if (d.class) s.class = text(d.class, 30);
        if (d.hp) s.hp = clamp(s.hp + clamp(num(d.hp), -s.hpMax, s.hpMax), 0, s.hpMax);
        if (d.mana) s.mana = clamp(s.mana + clamp(num(d.mana), -s.manaMax, s.manaMax), 0, s.manaMax);

        if (d.xp) {
            const mode = settings().xpMode;
            if (mode === 'free') gainXp(s, clamp(num(d.xp), 0, 100), notes);
            else if (mode === 'mixed') gainXp(s, clamp(num(d.xp), 0, MIXED_CAP), notes);
            // 'quests' mode: loose XP from the model is ignored
        }

        // the narrator may reward genuinely inspired roleplay with 1 Luck (rarely; capped at +1 per reply)
        if (d.luck > 0) gainLuck(s, notes, 'inspired play');

        // loot, purchases, used-up items, gold (items are normalised/capped by normItem)
        if (d.inv && typeof d.inv === 'object') {
            for (const it of [].concat(d.inv.add || []).slice(0, 4)) {
                const added = addItem(s, it);
                if (added) notes.push(['info', `Gained: ${added.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`]);
            }
            for (const it of [].concat(d.inv.remove || []).slice(0, 4)) {
                const r = removeItem(s, typeof it === 'string' ? it : it?.name, it?.qty);
                if (r) notes.push(['info', `Lost: ${r.name}`]);
            }
            if (d.inv.gold) {
                const g = clamp(Math.round(num(d.inv.gold)), -9999, 9999);
                s.gold = Math.max(0, s.gold + g);
                notes.push(['info', `${g >= 0 ? '+' : ''}${g} ${genreOf(s).terms.cash}`]);
            }
        }

        // combat roster: the game tracks enemy HP from the player's hits
        if (d.enemies && typeof d.enemies === 'object') {
            if (d.enemies.clear) s.enemies = [];
            for (const e of [].concat(d.enemies.add || []).slice(0, 6)) addEnemy(s, e);
            for (const n of [].concat(d.enemies.remove || [])) s.enemies = s.enemies.filter((e) => e.id !== slug(typeof n === 'string' ? n : n?.name));
        }

        // the model may unlock a skill when the player genuinely learns one in the story (rank 1, free, max 1 per turn)
        if (d.skills?.unlock && settings().modelUnlockSkills) {
            const u = [].concat(d.skills.unlock)[0];
            const name = typeof u === 'string' ? u : u?.name;
            if (name && !(s.skills || (s.skills = [])).some((k) => k.id === slug(name))) {
                if (addSkill(s, name, u?.desc, { base: 1 })) notes.push(['success', `New skill learned: ${name}`]);
            }
        }

        if (d.scene && typeof d.scene === 'object') {
            for (const k of ['region', 'location', 'time']) if (d.scene[k]) s.scene[k] = text(d.scene[k], 80);
        }

        if (d.rel && typeof d.rel === 'object') {
            const REL_STEP = 25; // max swing per NPC per reply
            for (const [rawName, v] of Object.entries(d.rel).slice(0, 6)) {
                const name = safeName(rawName);
                if (!name) continue;
                const r = Object.hasOwn(s.rel, name) ? s.rel[name] : { value: 0, note: '' };
                const before = tierOf(r.value);
                if (typeof v === 'number') r.value += clamp(v, -REL_STEP, REL_STEP);
                else if (v && typeof v === 'object') {
                    if (v.set !== undefined) r.value = clamp(num(v.set), r.value - REL_STEP, r.value + REL_STEP);
                    if (v.delta) r.value += clamp(num(v.delta), -REL_STEP, REL_STEP);
                    if (v.note) r.note = text(v.note, 120);
                }
                r.value = clamp(Math.round(r.value), -100, 100);
                s.rel[name] = r;
                const after = tierOf(r.value);
                if (after !== before) notes.push(['info', `${name}: ${before} → ${after}`]);
            }
        }

        if (d.party && typeof d.party === 'object') {
            const combat = hasCombat(s);
            for (const m of [].concat(d.party.add || []).slice(0, 2)) {
                const p = addMember(s, m);
                if (p) notes.push(['success', `${p.name} joined the party`]);
            }
            for (const u of [].concat(d.party.update || []).slice(0, 6)) {
                const p = findMember(s, u?.name ?? u?.id);
                if (!p) continue;
                const was = p.hp;
                if (combat && u.hp) p.hp = clamp(p.hp + clamp(num(u.hp), -p.hpMax, p.hpMax), 0, p.hpMax);
                if (combat && u.mana) p.mana = clamp(p.mana + clamp(num(u.mana), -p.manaMax, p.manaMax), 0, p.manaMax);
                if (u.level) p.level = clamp(Math.round(num(u.level, p.level)), 1, 20);
                if (u.class) p.class = text(u.class, 30);
                if (u.note !== undefined) p.note = text(u.note, 120);
                for (const k of normSkills(u.skills)) {
                    const have = p.skills.find((x) => x.name.toLowerCase() === k.name.toLowerCase());
                    if (have) have.rank = k.rank; else if (p.skills.length < 12) p.skills.push(k);
                }
                for (const a of [].concat(u.abilities || []).slice(0, 2)) {
                    const added = addAbility(p, a);
                    if (added) notes.push(['info', `${p.name} learned ${added.name}`]);
                }
                if (u.inv && typeof u.inv === 'object') { // loot picked up / things used up by this companion
                    for (const it of [].concat(u.inv.add || []).slice(0, 3)) {
                        const added = addToBag(p.inv, it, s.level);
                        if (added) notes.push(['info', `${p.name} gained: ${added.name}`]);
                    }
                    for (const it of [].concat(u.inv.remove || []).slice(0, 3)) {
                        const found = findInBag(p.inv, { name: typeof it === 'string' ? it : it?.name });
                        if (found) { found.qty -= Math.max(1, Math.round(num(it?.qty, 1))); if (found.qty <= 0) p.inv.splice(p.inv.indexOf(found), 1); }
                    }
                }
                if (combat && was > 0 && p.hp === 0) notes.push(['warning', `${p.name} is down!`]);
            }
            // handing gear between the player and companions (or between companions)
            const holder = (ref) => {
                const r = slug(ref ?? '');
                if (!r) return null;
                return ['player', 'you', 'me'].includes(r) || r === slug(s.name) ? 'player' : findMember(s, ref)?.id || null;
            };
            for (const t of [].concat(d.party.transfer || []).slice(0, 4)) {
                const from = holder(t?.from ?? 'player'), to = holder(t?.to);
                if (!from || !to) continue;
                const r = transferItem(s, { name: t.item ?? t.name, from, to, qty: t.qty });
                if (r) notes.push(['info', `${bagName(s, from)} gave ${r.item.name}${r.qty > 1 ? ` ×${r.qty}` : ''} to ${bagName(s, to)}`]);
            }
            for (const ref of [].concat(d.party.remove || []).slice(0, 3)) {
                const p = findMember(s, typeof ref === 'string' ? ref : ref?.name);
                if (p) {
                    const gear = returnGear(s, p);
                    s.party = s.party.filter((x) => x !== p);
                    notes.push(['info', `${p.name} left the party${gear ? ` — their gear (${gear} item${gear === 1 ? '' : 's'}) went back to your pack` : ''}`]);
                }
            }
        }

        const q = d.quests;
        if (q && typeof q === 'object') {
            const find = (ref) => s.quests.find((x) => x.id === ref || x.title.toLowerCase() === String(ref).toLowerCase());
            for (const a of [].concat(q.add || []).slice(0, 3)) {
                if (!a?.title || find(a.id || a.title)) continue;
                s.quests.push({
                    id: a.id ? text(a.id, 40) : `q${Date.now().toString(36)}${s.quests.length}`,
                    title: text(a.title, 80), desc: text(a.desc || '', 200), progress: '', status: 'active',
                    difficulty: normDiff(a.difficulty), xp: DIFFICULTY[normDiff(a.difficulty)], paid: 0, ms: 0, awarded: false,
                });
                notes.push(['info', `New quest: ${a.title}`]);
            }
            for (const u of [].concat(q.update || []).slice(0, 6)) {
                const t = find(u?.id || u?.title);
                if (!t) continue;
                if (u.progress) t.progress = text(u.progress, 200);
                if (u.desc) t.desc = text(u.desc, 200);
                if (u.milestone && t.status === 'active' && (t.ms || 0) < MILESTONE_MAX) {
                    t.ms = (t.ms || 0) + 1;
                    const part = Math.round(questReward(t) * MILESTONE_SHARE);
                    t.paid = (t.paid || 0) + part; // deducted from the final payout
                    gainXp(s, part, notes, `${t.title} (milestone)`);
                }
            }
            for (const ref of q.complete || []) {
                const t = find(ref);
                if (t) completeQuest(s, t, notes);
            }
            for (const ref of q.fail || []) {
                const t = find(ref);
                if (t && t.status !== 'failed') { t.status = 'failed'; notes.push(['warning', `Quest failed: ${t.title}`]); }
            }
        }

        // attacks the narrator resolved without dice: allies' hits are applied to the enemy; enemy hits are log-only
        // (their damage to the party arrives through "party.update" or a defend check, so it isn't applied twice)
        if (Array.isArray(d.attacks) && hasCombat(s)) {
            for (const a of d.attacks.slice(0, 6)) {
                const who = text(a?.who ?? '', 40).trim(), target = text(a?.target ?? '', 40).trim();
                if (!who || !target) continue;
                const hit = a.hit !== false && a.hit !== 0 && a.hit !== 'false';
                const crit = hit && !!a.crit;
                let dmg = hit ? clamp(Math.round(num(a.dmg, 0)), 0, 200) : 0;
                const ally = findMember(s, who), isPlayer = slug(who) === slug(s.name);
                // a companion's wielded weapon decides the damage: the narrator only says hit or miss
                const wpn = ally ? equippedIn(ally.inv, 'weapon') : null;
                if (hit && wpn && parseDice(wpn.dmg, ally.level)) dmg = Math.max(1, rollDice(parseDice(wpn.dmg, ally.level), { crit, extra: wpn.bonus || 0 }).total);
                const side = ally || isPlayer ? 'ally' : 'foe';
                const foe = side === 'ally' ? findEnemy(s, target) : null;
                if (foe && dmg) {
                    foe.hp = Math.max(0, foe.hp - dmg);
                    if (foe.hp === 0) { foe.defeated = true; notes.push(['success', `${foe.name} defeated`]); }
                }
                logAttack(s, {
                    side, who: ally?.name || (isPlayer ? s.name : who), target: foe?.name || findMember(s, target)?.name || target,
                    nat: crit ? 20 : null, hit, crit, dmg, how: 'attack',
                });
            }
        }

        if (d.initiative && typeof d.initiative === 'object') {
            syncInitiative(s); // make sure enemies added in this same reply are in the order first
            for (let i = 0, n = clamp(Math.round(num(d.initiative.next, 0)), 0, 6); i < n; i++) nextTurn(s);
        }
        return notes;
    }

    // Models sometimes write the payload as a visible line instead of inside the hidden comment, e.g.
    //   OGT:{"hp":-2}      check:{"skill":"Magic","dc":15}      "roll":{...}
    // Catch those too so nothing leaks into the story and the request still works.
    const BARE_RE = /^[ \t>*_`-]*(?:OGT\s*:\s*(\{.*\})|"?(check|roll)"?\s*:\s*(\{.*\}))[ \t,`*_]*$/gim;
    const hasTags = (text) => new RegExp(TAG_RE.source, 'i').test(text) || new RegExp(BARE_RE.source, 'im').test(text);
    const stripTags = (text) => text.replace(TAG_RE, '').replace(BARE_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();

    // Close whatever a truncated JSON payload left open (string, arrays, objects) so a cut-off tag still applies.
    function repairJson(raw) {
        const stack = [];
        let inStr = false, esc = false;
        for (const ch of raw) {
            if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
            if (ch === '"') inStr = true;
            else if (ch === '{') stack.push('}');
            else if (ch === '[') stack.push(']');
            else if (ch === '}' || ch === ']') stack.pop();
        }
        let out = raw;
        if (inStr) out += esc ? '\\"' : '"';
        out = out.replace(/[,:]\s*$/, (m) => (m.trim() === ':' ? ':null' : ''));
        return out + stack.reverse().join('');
    }

    function parseTags(text) {
        const deltas = [];
        let m;
        parseIssues = { repaired: 0, failed: 0 };
        TAG_RE.lastIndex = 0;
        while ((m = TAG_RE.exec(text))) {
            const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/^```(?:json)?|```$/g, '').trim();
            try { deltas.push(JSON.parse(raw)); } catch (e) {
                try { deltas.push(JSON.parse(repairJson(raw))); parseIssues.repaired++; console.warn(`[${MODULE}] repaired truncated OGT json`); }
                catch (e2) { parseIssues.failed++; console.warn(`[${MODULE}] bad OGT json`, raw); }
            }
        }
        BARE_RE.lastIndex = 0;
        while ((m = BARE_RE.exec(text))) {
            try {
                if (m[1]) deltas.push(JSON.parse(m[1]));
                else deltas.push({ [m[2].toLowerCase()]: JSON.parse(m[3]) });
            } catch (e) { parseIssues.failed++; console.warn(`[${MODULE}] bad bare OGT json`, m[0]); }
        }
        return deltas;
    }

    let lastScanAt = -99;
    function onMessageReceived(id) {
        const s = settings();
        if (!s.enabled) return;
        const c = ctx();
        const msg = c.chat[id];
        if (!msg || msg.is_user || msg.is_system || typeof msg.mes !== 'string') return;
        c.chat.forEach((m) => m.extra?.ogt_notes?.forEach((n) => { n.done = true; })); // the narrator has now seen them
        if (!hasTags(msg.mes)) {
            lastStatus = 'Last reply had NO tracker tag' + (s.autoScan ? ' — auto-scanning…' : '.');
            console.warn(`[${MODULE}] no OGT tag in reply`, msg.mes.slice(-200));
            // the fallback scan is a second full-context API call, so rate-limit it (at most once per 6 messages)
            if (s.autoScan && c.chat.length - lastScanAt >= 6) { lastScanAt = c.chat.length; setTimeout(() => scanStory({ silent: true }), 1500); }
            pendingRoll = null; refreshPrompt();
            return render();
        }
        lastStatus = 'Last reply: tracker tag found and applied.';

        const state = getState();
        const notes = [];
        const deltas = parseTags(msg.mes);
        for (const d of deltas) notes.push(...applyDelta(state, d));
        recalcParty(state);
        syncInitiative(state);
        if (parseIssues.failed) {
            lastStatus = 'Last reply: tracker tag was unreadable' + (parseIssues.repaired ? ' (one part repaired)' : '') + ' — some updates were lost. Try the scan button.';
            notes.push(['warning', 'Tracker tag was cut off or malformed']);
        } else if (parseIssues.repaired) {
            lastStatus = 'Last reply: tracker tag was cut off and repaired — check it applied everything.';
            notes.push(['warning', 'Tracker tag was cut off — repaired']);
        }

        msg.mes = stripTags(msg.mes);
        msg.extra = msg.extra || {};
        msg.extra.ogt_snap = clone(state);

        delete msg.extra.ogt_roll; delete msg.extra.ogt_check;
        if (s.dice && s.rollMode === 'manual') {
            // the model asks for a check; the player rolls it by clicking the card
            const req = deltas.find((d) => d?.check)?.check;
            if (req && typeof req === 'object') {
                const base = { mod: clamp(Math.round(num(req.mod, 0)), -5, 5), adv: Math.sign(num(req.adv, 0)), why: String(req.why || '').slice(0, 80) };
                const kind = String(req.kind || '').toLowerCase();
                if ((kind === 'attack' || kind === 'defend') && !hasCombat(state)) {
                    // a no-combat game has no combat engine; if the model asks for one anyway, drop the request instead of tracking fights
                } else if (kind === 'attack') {
                    const spell = !!req.spell;
                    msg.extra.ogt_check = {
                        ...base, kind: 'attack', spell, target: String(req.target || 'target').slice(0, 30), dmg: spell ? String(req.dmg || '1d8') : undefined,
                        ac: clamp(Math.round(num(req.ac, findEnemy(state, req.target)?.ac ?? 12)), 5, 25), bonus: attackProfile(state, spell).bonus,
                    };
                } else if (kind === 'defend') {
                    msg.extra.ogt_check = {
                        ...base, kind: 'defend', enemy: String(req.enemy || 'The enemy').slice(0, 30), atk: clamp(Math.round(num(req.atk, 3)), 0, 4 + state.level),
                        dmg: String(req.dmg || '1d6'), ac: computeAC(state),
                        target: findMember(state, req.target)?.name, // undefined = the player
                    };
                } else {
                    const sk = findSkill(state, req.skill);
                    const ab = ABILITIES.includes(req.ability) ? req.ability : null;
                    msg.extra.ogt_check = {
                        ...base, kind: 'skill', trained: !!sk, ability: sk ? abilityOf(sk) : ab,
                        skill: sk?.name || (ab ? AB_FULL[ab] : String(req.skill || 'Unskilled').slice(0, 30)),
                        bonus: sk ? skillBonus(state, sk) : (ab ? amod(state.stats?.[ab]) : 0),
                        npc: req.npc ? String(req.npc).slice(0, 30) : undefined, rel: socialBonus(state, req.npc),
                        dc: clamp(Math.round(num(req.dc, 12)), 5, 30),
                    };
                }
            }
        } else if (s.dice) {
            const roll = resolveRoll(deltas.find((d) => d?.roll)?.roll, pendingRoll, state);
            if (roll) msg.extra.ogt_roll = roll;
        }
        pendingRoll = null;
        scheduleDecorate();

        try { c.updateMessageBlock?.(id, msg); } catch (e) { /* message may not be rendered yet */ }
        pruneSnapshots();
        const done = state.quests.filter((q) => q.status !== 'active'); // don't let finished quests pile up forever
        if (done.length > 30) state.quests = state.quests.filter((q) => q.status === 'active' || done.indexOf(q) >= done.length - 30);
        persist(); // single debounced save (SillyTavern also saves the chat itself after each reply)
        if (s.toasts) notes.forEach(([type, text]) => notify(type, text));
    }

    // ───────────────────────── prompt injection ─────────────────────────

    function buildPrompt() {
        const s = getState();
        const combat = hasCombat(s); // social genres have no HP / AC / enemies at all
        const compact = {
            player: s.name, class: s.class, level: s.level, xp: `${s.xp}/${xpNeeded(s.level)}`,
            hp: combat ? `${s.hp}/${s.hpMax}` : undefined, mana: combat ? `${s.mana}/${s.manaMax}` : undefined,
            scene: s.scene,
            // keep the injected state bounded as a long game accumulates NPCs / notes (most significant relationships first)
            relationships: !settings().trackRel ? undefined : Object.fromEntries(Object.entries(s.rel)
                .sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value)).slice(0, 12)
                .map(([n, r]) => [n, `${r.value} (${tierOf(r.value)})${r.note ? ' - ' + String(r.note).slice(0, 70) : ''}`])),
            traits: s.traits || undefined,
            backstory: s.backstory ? String(s.backstory).slice(0, 500) : undefined,
            skills: Object.fromEntries((s.skills || []).map((k) => [k.name, `${fmtMod(skillBonus(s, k))} (rank ${k.rank}/${settings().skillMaxRank} ${RANK_NAMES[k.rank] || ''})`])),
            abilities: Object.fromEntries(ABILITIES.map((a) => [AB_NAME[a], `${s.stats[a]} (${fmtMod(amod(s.stats[a]))})`])),
            armor_class: combat ? computeAC(s) : undefined,
            luck: settings().luckRerolls ? `${s.luck}/${s.luckMax}` : undefined,
            abilities: combat && s.abilities?.length ? s.abilities.map((a) => `${a.name} (${a.cost} ${G().terms.mana.toLowerCase()}, ${a.kind === 'heal' ? 'heals ' : ''}${a.dmg})`) : undefined,
            gear: combat ? {
                weapon: (() => { const w = equippedOf(s, 'weapon'); return w ? `${w.name} (${w.dmg}${w.bonus ? ` +${w.bonus}` : ''}, ${AB_NAME[w.ability]})` : 'unarmed'; })(),
                armor: equippedOf(s, 'armor')?.name || 'none', shield: equippedOf(s, 'shield')?.name || 'none',
                pack: Object.fromEntries(s.inv.filter((i) => !i.equipped).slice(0, 25).map((i) => [i.name, i.qty])), gold: s.gold,
            } : { belongings: Object.fromEntries(s.inv.slice(0, 25).map((i) => [i.name, i.qty])), [genreOf(s).terms.cash]: s.gold },
            enemies: combat ? s.enemies.filter((e) => !e.defeated).map((e) => ({ name: e.name, hp: `${e.hp}/${e.hpMax}`, ac: e.ac })) : undefined,
            initiative: combat && s.combat?.order.length ? {
                round: s.combat.round, now: s.combat.order[s.combat.turn]?.name, order: s.combat.order.map((o) => o.name),
            } : undefined,
            party: settings().trackParty && s.party.length ? s.party.map((p) => ({
                name: p.name, class: p.class, level: p.level,
                hp: combat ? `${p.hp}/${p.hpMax}${p.hp === 0 ? ' DOWN' : ''}` : undefined, mana: combat && p.manaMax ? `${p.mana}/${p.manaMax}` : undefined,
                ac: combat ? p.ac : undefined, skills: p.skills.length ? Object.fromEntries(p.skills.map((k) => [k.name, k.rank])) : undefined, note: p.note || undefined,
                control: combat ? (isPlayed(p) ? 'player' : 'game') : undefined,
                carrying: p.inv.length ? itemsText(p.inv) : undefined,
                abilities: combat && p.abilities?.length ? p.abilities.map((a) => `${a.name} (${a.cost} mana, ${a.kind === 'heal' ? 'heals ' : ''}${a.dmg})`) : undefined,
                equipped: combat && p.inv.some((i) => i.equipped) ? p.inv.filter((i) => i.equipped).map((i) => (i.type === 'weapon' ? `${i.name} (${i.dmg})` : i.name)).join(', ') : undefined,
            })) : undefined,
            quests: s.quests.filter((q) => q.status === 'active').slice(-8).map((q) => ({ id: q.id, title: q.title, desc: String(q.desc || '').slice(0, 100), progress: String(q.progress || '').slice(0, 100), difficulty: q.difficulty, reward: `${questReward(q)} XP` })),
        };
        const extra = settings().extraRules?.trim();
        return `[Game tracker — out-of-character system rules. Never mention or quote this block in the story.]
Current tracked state:
${JSON.stringify(compact)}

${G().prompt.setting}Honour this state in the narrative (injured characters act injured, NPC attitudes match their relationship tier, active quests stay relevant). Skills are the player's real competence: rank 1 = novice, 5 = master. Let outcomes reflect them — a rank-1 skill fumbles under pressure, a rank-5 skill is reliable — and never let the player perform feats far above their rank or level without consequence. Skill ranks are raised by the player with skill points, not by you.${combat ? " The player's armor_class is derived from their gear and DEX; enemies must hit it." : ' This game has NO combat engine: there is no HP, armor class or enemy tracking, so never request attack or defend checks and never report "hp", "mana" or "enemies". If a physical scuffle erupts, handle it in the story or with a single skill check.'} Items: use "inv.add" only for loot, rewards or purchases the player actually obtains ${G().prompt.itemRules} Use "inv.remove" when an item is lost, stolen, given away or used up in the story; the game removes potions the player drinks itself.

At the very END of EVERY reply, after all narrative, append exactly ONE hidden HTML comment with only the values that CHANGED this turn:
<!--OGT:{...json...}-->
Schema (omit anything unchanged; use {} content only if nothing changed — or omit the comment):
{${combat ? '"hp":-3,"mana":-1,' : ''}${settings().xpMode === 'quests' ? '' : '"xp":5,'}"class":"${G().prompt.classExample}",
 "scene":{${G().prompt.sceneExample}},
${settings().trackRel ? ` "rel":{"${G().prompt.npcExample}":{"delta":5,"note":"short reason / how they feel"}},\n` : ''}${settings().modelUnlockSkills ? ' "skills":{"unlock":[{"name":"Lockpicking","desc":"one line"}]},\n' : ''} "inv":${G().prompt.invExample},
${combat ? ` "enemies":{"add":[{"name":"${G().prompt.enemyExample}","hp":9,"ac":13,"atk":4,"dmg":"1d6+1"}],"clear":true},\n` : ''}${settings().trackParty ? ` "party":{"add":[{"name":"Mira","class":"Rogue","level":2${combat ? ',"hp":22,"mana":0,"ac":13' : ''},"stats":{"dex":15,"cha":12},"skills":[["Stealth",3]]}],"update":[{"name":"Mira"${combat ? ',"hp":-4' : ''},"note":"short"}],"transfer":[{"item":"Healing Potion","from":"player","to":"Mira","qty":1}],"remove":["Mira"]},\n` : ''} "quests":{"add":[{"id":"short_id","title":"Quest title","desc":"one line objective","difficulty":"trivial|easy|medium|hard|deadly"}],
           "update":[{"id":"short_id","progress":"what's done / what's next","milestone":true}],
           "complete":["short_id"],"fail":["short_id"]}}
Rules: ${combat ? `hp${settings().xpMode === 'quests' ? '/mana are' : '/mana/xp are'} DELTAS (hp negative for damage, positive for healing).` : (settings().xpMode === 'quests' ? '' : 'xp is a DELTA.')} ${settings().xpMode === 'quests'
    ? 'Do NOT award xp yourself — the game pays XP automatically when a quest is completed. When a quest begins, pick its "difficulty" honestly relative to the player\'s level (trivial: errand; easy: minor risk; medium: real danger or effort; hard: serious threat; deadly: likely lethal). Add "milestone":true to a quest update only when a major objective step is genuinely finished (max 3 per quest). Put a quest id in "complete" only when its goal is fully achieved.'
    : 'Award xp (roughly 3–10) only for meaningful achievements; quest completion is paid automatically from the quest\'s difficulty.'}${settings().trackRel ? " Relationship delta is usually -15..+15 on a -100..100 scale; use it whenever an NPC's feelings toward the player change, and add new NPCs the first time they matter." : ''}${settings().modelUnlockSkills ? ' Use "skills.unlock" only when the player actually learns a brand-new skill through in-story training or discovery (at most one per turn; never for skills they already have).' : ''} Always keep "scene" current when location or time of day changes.${settings().trackParty ? ` Party: "party.add" only when a named ally actually joins the player's group for the journey (not passing NPCs; max ${PARTY_MAX} members); give sensible stats for their class and level.${combat ? ' "party.update" hp/mana are DELTAS (negative for damage) — apply them whenever a party member is hurt, healed or spends mana, and resolve their actions yourself, without dice.' : ''} Companions carry their own gear (see "carrying"): when the player hands an item to one (or takes it back, or one gives another something) report "party.transfer" with the item name, from/to ("player" or the member's name) and qty — only items that exist in the giver's bag can move. Loot a companion picks up or items they use up go in that member's "party.update" as "inv":{"add":[…],"remove":["Healing Potion"]}. Use "party.remove" when they leave, die or are lost for good (their gear returns to the player's pack).` : ''} Valid JSON only, on a single line. Keep the whole comment SHORT (under ~300 characters): only changed fields, short ids, and "note"/"progress" text of at most 8 words. Always finish it with the closing }-->.${extra ? '\n' + extra : ''}${diceBlock(s)}${resultBlock()}${notesBlock()}`;
    }

    function refreshPrompt() {
        const c = ctx();
        const s = settings();
        const on = s.enabled && s.inject && !!c.chatMetadata;
        // position 1 = IN_CHAT, role 0 = system
        c.setExtensionPrompt(MODULE, on ? buildPrompt() : '', 1, num(s.depth, 1), false, 0);
    }

    // ───────────────────────── rendering ─────────────────────────

    function avatarUrl(s) {
        if (s.avatar) return s.avatar;
        const sel = document.querySelector('#user_avatar_block .avatar-container.selected, #user_avatar_block .avatar.selected');
        const id = sel?.getAttribute('data-avatar-id') || sel?.getAttribute('imgfile');
        if (id) return `/thumbnail?type=persona&file=${encodeURIComponent(id)}`;
        return sel?.querySelector('img')?.getAttribute('src') || '';
    }

    function bar(label, cls, cur, max) {
        const pct = max > 0 ? clamp((cur / max) * 100, 0, 100) : 0;
        return `<div class="ogt-bar-row"><span class="ogt-bar-label">${label}</span>
            <div class="ogt-bar"><div class="ogt-fill ${cls}" style="width:${pct}%"></div></div>
            <span class="ogt-bar-val">${cur}/${max}</span></div>`;
    }

    /** Does this genre use the HP / AC / enemies layer? Social genres turn it off entirely. */
    // off for no-combat genres, or when this chat's "Combat system" toggle (GM tab) is switched off
    const hasCombat = (s) => genreOf(s).combat !== false && !s?.combatOff;

    function renderCharacter(s) {
        const av = avatarUrl(s);
        const combat = hasCombat(s);
        const field = (k, label, type = 'number') =>
            `<label>${label}<input data-ogt-field="${k}" type="${type}" value="${esc(s[k])}"></label>`;
        let h = `<div class="ogt-card">
            <div class="ogt-portrait" style="${cssUrl(av) ? `background-image:url('${esc(cssUrl(av))}')` : ''}">${cssUrl(av) ? '' : `<span>${esc(s.name[0] || '?')}</span>`}</div>
            ${combat ? `<div class="ogt-ac" title="Armor Class">🛡 ${computeAC(s)}</div>` : ''}
            <div class="ogt-card-text"><div class="ogt-name">${esc(s.name)}</div><div class="ogt-class">${esc(s.class)}</div></div>
        </div>
        <div class="ogt-stats">
            ${combat ? `${bar('HP', 'hp', s.hp, s.hpMax)}
            ${bar(G().terms.mana.toUpperCase(), 'mana', s.mana, s.manaMax)}` : ''}
            ${bar(`LVL ${s.level}`, 'xp', s.xp, xpNeeded(s.level))}
        </div>
        <div class="ogt-abilities">${ABILITIES.map((a) => `<div class="ogt-ab" title="${AB_NAME[a]} ${s.stats[a]}">
            <div class="n">${AB_NAME[a]}</div><div class="v">${s.stats[a]}</div><div class="m">${fmtMod(amod(s.stats[a]))}</div>
            ${s.statPoints > 0 && s.stats[a] < 20 ? `<button data-ogt-act="stat-up" data-ab="${a}" title="Spend an ability point">+</button>` : ''}</div>`).join('')}</div>
        <div class="ogt-acrow">${combat ? `AC <b>${computeAC(s)}</b> · ` : ''}Proficiency <b>${fmtMod(profBonus(s.level))}</b> · <b>${s.gold}</b> ${G().terms.cash}${settings().luckRerolls ? ` · <span class="luck" title="Spend Luck to reroll a failed check">🍀 <b>${s.luck}/${s.luckMax}</b></span>` : ''}${s.statPoints > 0 ? ` · <span class="pts">${s.statPoints} ability point${s.statPoints === 1 ? '' : 's'}</span>` : ''}</div>`;

        if (combat && (s.abilities?.length || editingChar)) h += `<div class="ogt-section">ABILITIES</div>${abilitiesHtml(s, 'player', editingChar)}`;

        // no-combat genres: the people in your life come first, right under your stats
        if (!combat && settings().trackRel) h += relationshipsHtml(s);

        const foes = s.enemies.filter((e) => !e.defeated);
        if (combat && s.enemies.length) {
            h += `<div class="ogt-section">COMBAT</div>${initiativeHtml(s)}${actionBarHtml(s)}${s.enemies.map((e) => `<div class="ogt-foe ${e.defeated ? 'dead' : ''}" data-eid="${esc(e.id)}">
                <div class="ogt-foe-head"><span>${esc(e.name)}</span><span>AC ${e.ac}</span></div>
                <div class="ogt-bar"><div class="ogt-fill hp" style="width:${clamp((e.hp / e.hpMax) * 100, 0, 100)}%"></div></div>
                <div class="ogt-foe-foot"><span>${e.defeated ? 'Defeated' : `${e.hp}/${e.hpMax} HP · ${(() => { const st = enemyStats(s, e); return `${fmtMod(st.atk)} to hit · ${esc(st.dmg)}`; })()}`}</span><button class="ogt-btn small" data-ogt-act="foe-del" title="Remove">✕</button></div></div>`).join('')}
                ${foes.length ? '' : '<div class="ogt-empty">All enemies defeated.</div>'}
                <button class="ogt-btn ogt-wide" data-ogt-act="foes-clear">End combat</button>${attackLogHtml(s)}`;
        }

        if (s.skillPoints > 0) {
            h += `<button class="ogt-btn ogt-wide ogt-spend" data-ogt-act="goto-skills">${s.skillPoints} skill point${s.skillPoints === 1 ? '' : 's'} to spend ›</button>`;
        }

        if (s.scene.location || s.scene.region || s.scene.time) {
            h += `<div class="ogt-scene"><div class="ogt-scene-top">${esc([s.scene.region, s.scene.time].filter(Boolean).join(' · '))}</div>
                <div class="ogt-scene-loc">${esc(s.scene.location)}</div></div>`;
        }

        const noPlay = !ctx().chat.some((m) => m.is_user);
        if (!s.created && noPlay) {
            h += `<button class="ogt-btn ogt-wide ogt-spend" data-ogt-act="open-creator">✦ Create your character</button>`;
        }
        h += `<button class="ogt-btn ogt-wide" data-ogt-act="toggle-edit">${editingChar ? 'Done editing' : 'Edit character'}</button>`;
        if (editingChar || s.created) h += `<button class="ogt-btn ogt-wide" data-ogt-act="open-creator">${s.created ? 'Re-open character creator' : 'Character creator'}</button>`;
        if (editingChar) {
            h += `<div class="ogt-form">
                ${field('name', 'Name', 'text')}${field('class', 'Class', 'text')}${field('avatar', 'Portrait URL', 'text')}
                ${field('level', 'Level')}${field('xp', 'XP')}
                ${combat ? `${field('hp', 'HP')}${field('hpMax', 'Max HP')}${field('mana', G().terms.mana)}${field('manaMax', 'Max ' + G().terms.mana.toLowerCase())}` : ''}${field('luck', 'Luck')}${field('luckMax', 'Max luck')}
                ${ABILITIES.map((a) => `<label>${AB_NAME[a]}<input data-ogt-stat="${a}" type="number" min="1" max="30" value="${s.stats[a]}"></label>`).join('')}
            </div>`;
        }

        if (!settings().trackRel || !combat) return h; // (no-combat genres already showed relationships above)
        return h + relationshipsHtml(s);
    }

    /** Ability list for the player or a companion: name, cost and damage / healing. `editing` adds delete buttons and the add form. */
    function abilitiesHtml(owner, ownerId, editing) {
        const mana = G().terms.mana;
        const list = owner.abilities || [];
        let h = list.length ? list.map((a) => `<div class="ogt-ab-row"><span><b>${esc(a.name)}</b> · ${a.cost} ${esc(mana)} · ${a.kind === 'heal' ? 'heals ' : ''}${esc(a.dmg)}</span>
            ${editing ? `<button class="ogt-btn small" data-ogt-act="ab-del" data-owner="${esc(ownerId)}" data-aid="${esc(a.id)}" title="Forget">✕</button>` : ''}</div>`).join('')
            : (editing ? '<div class="ogt-empty">No abilities yet.</div>' : '');
        if (editing && list.length < ABILITY_MAX) {
            const id = (k) => `ogt-ab-${k}-${esc(ownerId)}`;
            h += `<div class="ogt-form ogt-ab-form">
                <label>Ability<input id="${id('name')}" type="text" placeholder="e.g. Fireball"></label>
                <label>${esc(mana)} cost<input id="${id('cost')}" type="number" min="0" max="20" value="1"></label>
                <label>Damage / heal dice<input id="${id('dmg')}" type="text" value="1d8" placeholder="2d6"></label>
                <label>Type<select id="${id('kind')}"><option value="attack">Attack (rolls to hit)</option><option value="heal">Heal an ally</option></select></label>
                <button class="ogt-btn ogt-wide" data-ogt-act="ab-add" data-owner="${esc(ownerId)}">Add / replace ability</button></div>`;
        }
        return h;
    }

    /** The turn's available actions for whoever you control right now (you or a companion). */
    function actionBarHtml(s) {
        const c = s.combat;
        if (!c?.order.length) return '';
        const h = turnHolder(s);
        if (!h) {
            const o = c.order[c.turn];
            return `<div class="ogt-act foe"><div class="ogt-act-head"><span>${o?.kind === 'party' ? '🛡' : '☠'} ${esc(o?.name || 'Enemy')}'s turn</span></div>
                <div class="ogt-empty">${o?.kind === 'party' ? 'Allies are played by the narrator (setting).' : 'Enemy turns are played by the narrator.'} Continue the story, or press Next turn.</div></div>`;
        }
        const mana = G().terms.mana, ref = h.ref;
        const foes = s.enemies.filter((e) => !e.defeated);
        actSel.foe = foes.find((e) => e.id === actSel.foe)?.id || foes[0]?.id || '';
        const allies = [['player', `${s.name} (you)`], ...s.party.map((p) => [p.id, p.name])];
        if (!allies.some(([v]) => v === actSel.ally)) actSel.ally = 'player';
        const items = usableItems(bagFor(s, h.id));
        if (!items.some((i) => `${i.id}|${i.type}` === actSel.item)) actSel.item = items[0] ? `${items[0].id}|${items[0].type}` : '';
        const st = attackStats(s, h.id, false);
        const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
        const abBtns = (ref.abilities || []).map((a) => `<button class="ogt-btn" data-ogt-act="act-ability" data-aid="${esc(a.id)}" ${ref.mana < a.cost ? 'disabled' : ''}>${esc(a.name)}
            <small>${a.cost} ${esc(mana)} · ${a.kind === 'heal' ? 'heals ' : ''}${esc(a.dmg)}</small></button>`).join('');
        return `<div class="ogt-act"><div class="ogt-act-head"><span>⚔ ${esc(h.name)}'s turn</span>${ref.manaMax ? `<span>${esc(mana)} ${ref.mana}/${ref.manaMax}</span>` : ''}</div>
            <div class="ogt-act-pick">
                <label class="ogt-target">Enemy <select id="ogt-act-foe" data-ogt-sel="foe">${foes.map((e) => opt(e.id, `${e.name} · AC ${e.ac} · ${e.hp}/${e.hpMax}`, actSel.foe)).join('')}</select></label>
                <label class="ogt-target">Ally <select id="ogt-act-ally" data-ogt-sel="ally">${allies.map(([v, l]) => opt(v, l, actSel.ally)).join('')}</select></label>
            </div>
            <div class="ogt-act-grid">
                <button class="ogt-btn" data-ogt-act="act-attack">⚔ Attack<small>${esc(st.how)} · ${esc(diceStr(st.dmgDice))} · ${fmtMod(st.bonus)} to hit</small></button>
                ${abBtns}
                <button class="ogt-btn" data-ogt-act="act-defend">🛡 Defend<small>attackers at disadvantage</small></button>
                <button class="ogt-btn" data-ogt-act="act-flee">🏃 Flee<small>whole party, DEX check</small></button>
            </div>
            ${items.length ? `<div class="ogt-act-pick"><label class="ogt-target">Item <select id="ogt-act-item" data-ogt-sel="item">${items.map((i) => opt(`${i.id}|${i.type}`, `${i.name}${i.qty > 1 ? ' ×' + i.qty : ''} · ${itemBadge(i)}`, actSel.item)).join('')}</select></label>
                <button class="ogt-btn small" data-ogt-act="act-item">Use on ally</button></div>` : ''}
            <div class="ogt-addrow"><input id="ogt-act-custom" placeholder="Something else… (the narrator decides)"><button class="ogt-btn small" data-ogt-act="act-custom">Do it</button></div></div>`;
    }

    /** Turn order for the current fight: highlighted current combatant, round counter, manual advance / reroll. */
    function initiativeHtml(s) {
        const c = s.combat;
        if (!c?.order.length) return '';
        const icon = { player: '⭐', party: '🛡', enemy: '☠' };
        return `<div class="ogt-init"><div class="ogt-init-head"><span>INITIATIVE · Round ${c.round}</span>
            <span>${turnHolder(s) ? '' : `<button class="ogt-btn small" data-ogt-act="init-run" title="Let the game play the enemy (and uncontrolled ally) turns until it is yours again">▶ Run turns</button>`}
            <button class="ogt-btn small" data-ogt-act="init-next" title="Advance to the next combatant">Next turn ›</button>
            <button class="ogt-btn small" data-ogt-act="init-reroll" title="Roll initiative again">🎲</button></span></div>
            ${c.order.map((o, i) => `<div class="ogt-init-row ${o.kind} ${i === c.turn ? 'now' : ''}"><span>${icon[o.kind] || ''} ${esc(o.name)}</span><span>${o.init}</span></div>`).join('')}</div>`;
    }

    /** Who hit whom: a summary of the current fight and the most recent attacks. */
    function attackLogHtml(s) {
        const log = s.log || [];
        if (!log.length) return '';
        const sum = (side, f) => log.filter((x) => x.side === side).reduce((a, x) => a + f(x), 0);
        const swings = log.filter((x) => x.side === 'ally');
        const dealt = sum('ally', (x) => x.dmg), taken = sum('foe', (x) => x.dmg);
        return `<div class="ogt-section">ATTACK LOG</div>
            <div class="ogt-empty">Allied hits ${swings.filter((x) => x.hit).length}/${swings.length} · damage dealt ${dealt} · damage taken ${taken}</div>
            <div class="ogt-log">${log.slice(-8).reverse().map((x) => `<div class="ogt-log-row ${x.side} ${x.hit ? 'hit' : 'miss'}">
                <span>R${x.round} · ${esc(x.who)} → ${esc(x.target)}</span><span>${x.crit ? 'CRIT ' : x.hit ? 'HIT ' : x.nat === 1 ? 'FUMBLE' : 'MISS'}${x.hit ? x.dmg : ''}</span></div>`).join('')}</div>`;
    }

    function relationshipsHtml(s) {
        let h = `<div class="ogt-section">RELATIONSHIPS</div>`;
        const names = Object.keys(s.rel);
        if (!names.length) h += `<div class="ogt-empty">No one knows you yet.</div>`;
        for (const n of names) {
            const r = s.rel[n];
            const open = expandedRel.has(n);
            const tier = tierOf(r.value);
            const tcls = r.value >= 15 ? 'pos' : r.value < 0 ? 'neg' : 'neu';
            h += `<div class="ogt-rel ${open ? 'open' : ''}" data-rel="${esc(n)}">
                <div class="ogt-rel-head" data-ogt-act="toggle-rel"><div><div class="ogt-rel-name">${esc(n)}</div>
                <div class="ogt-rel-tier ${tcls}">${esc(tier)}</div></div><span class="ogt-chev">▾</span></div>
                ${open ? `<div class="ogt-rel-body">
                    ${r.note ? `<div class="ogt-note">${esc(r.note)}</div>` : ''}
                    <input type="range" min="-100" max="100" value="${r.value}" data-ogt-rel-range="${esc(n)}">
                    <div class="ogt-rel-foot"><span>${r.value}</span><button class="ogt-btn small" data-ogt-act="del-rel">Remove</button></div>
                </div>` : ''}
            </div>`;
        }
        h += `<div class="ogt-addrow"><input id="ogt-new-rel" placeholder="Add NPC…"><button class="ogt-btn small" data-ogt-act="add-rel">Add</button></div>`;
        return h;
    }

    function renderParty(s) {
        const combat = hasCombat(s);
        const pf = (p, k, label, type = 'number') => `<label>${label}<input data-ogt-pfield="${k}" type="${type}" value="${esc(p[k])}"></label>`;
        let h = `<div class="ogt-section">PARTY (${s.party.length}/${PARTY_MAX})</div>`;
        if (!s.party.length) h += `<div class="ogt-empty">No companions yet. Add one below, or the narrator adds them when someone joins you.</div>`;
        for (const p of s.party) {
            const open = expandedParty.has(p.id);
            const down = combat && p.hp === 0;
            h += `<div class="ogt-rel ogt-pm ${open ? 'open' : ''} ${down ? 'down' : ''}" data-pid="${esc(p.id)}">
                <div class="ogt-rel-head" data-ogt-act="toggle-pm"><div><div class="ogt-rel-name">${esc(p.name)}</div>
                <div class="ogt-rel-tier neu">${esc(p.class)} · Lv ${p.level}${combat ? ` · AC ${p.ac} · ${isPlayed(p) ? '🎮 you play' : '🤖 ' + p.stance}` : ''}${down ? ' · DOWN' : ''}</div></div><span class="ogt-chev">▾</span></div>
                <div class="ogt-rel-body">
                    <div class="ogt-stats">${combat ? `${bar('HP', 'hp', p.hp, p.hpMax)}${p.manaMax ? bar(G().terms.mana.toUpperCase(), 'mana', p.mana, p.manaMax) : ''}` : ''}${p.level < 20 ? bar(`LVL ${p.level}`, 'xp', p.xp || 0, xpNeeded(p.level)) : ''}</div>
                    <div class="ogt-pm-abilities">${ABILITIES.map((a) => `<span title="${AB_FULL[a]}"><b>${AB_NAME[a]}</b> ${p.stats?.[a] ?? 10} <i>${fmtMod(amod(p.stats?.[a]))}</i></span>`).join('')}</div>
                    ${p.skills.length ? `<div class="ogt-pm-skills">${p.skills.map((k) => `<span class="ogt-xpchip">${esc(k.name)} ${k.rank}</span>`).join('')}</div>` : ''}
                    ${combat ? (() => { const st = attackStats(s, p.id, false); return `<div class="ogt-acrow">⚔ <b>${esc(st.how)}</b> · ${esc(diceStr(st.dmgDice))}${st.extra ? fmtMod(st.extra) : ''} damage · <b>${fmtMod(st.bonus)}</b> to hit</div>`; })() : ''}
                    ${combat ? abilitiesHtml(p, p.id, open) : ''}
                    ${p.note ? `<div class="ogt-note">${esc(p.note)}</div>` : ''}
                    ${!open && p.inv.length ? `<div class="ogt-note">🎒 ${esc(itemsText(p.inv))}</div>` : ''}
                    ${open ? `<div class="ogt-section">CARRYING</div>${p.inv.length ? p.inv.map((i) => memberItemHtml(s, p, i)).join('') : '<div class="ogt-empty">Nothing. Hand them something from your Gear tab.</div>'}
                    ${combat ? `<div class="ogt-pm-quick">
                        <button class="ogt-btn small" data-ogt-act="pm-hp" data-d="-5">HP −5</button><button class="ogt-btn small" data-ogt-act="pm-hp" data-d="-1">−1</button>
                        <button class="ogt-btn small" data-ogt-act="pm-hp" data-d="1">+1</button><button class="ogt-btn small" data-ogt-act="pm-hp" data-d="5">+5</button>
                        ${p.manaMax ? `<button class="ogt-btn small" data-ogt-act="pm-mana" data-d="-1">${esc(G().terms.mana)} −1</button><button class="ogt-btn small" data-ogt-act="pm-mana" data-d="1">+1</button>` : ''}
                        <button class="ogt-btn small" data-ogt-act="pm-full">Full heal</button></div>` : ''}
                    <div class="ogt-form">
                        ${pf(p, 'name', 'Name', 'text')}${pf(p, 'class', 'Class', 'text')}${pf(p, 'level', 'Level')}
                        ${combat ? `${pf(p, 'hp', 'HP')}${pf(p, 'hpMax', 'Max HP')}${pf(p, 'mana', G().terms.mana)}${pf(p, 'manaMax', 'Max ' + G().terms.mana.toLowerCase())}${pf(p, 'baseAc', 'Base AC (no armor)')}` : ''}
                        <label>Skills (name rank, …)<input data-ogt-pfield="skills" type="text" value="${esc(skillText(p))}"></label>
                        ${pf(p, 'note', 'Note', 'text')}
                        ${ABILITIES.map((a) => `<label>${AB_NAME[a]}<input data-ogt-pstat="${a}" type="number" min="3" max="20" value="${p.stats?.[a] ?? 10}"></label>`).join('')}
                    </div>
                    ${combat ? `<div class="ogt-section">TACTICS</div><div class="ogt-form">
                        <label>Who plays their turns<select data-ogt-pfield="control">
                            ${[['', `Default (${settings().allyControl ? 'me' : 'game'})`], ['me', 'Me — action bar'], ['auto', 'Game — follows tactics']].map(([v, l]) => `<option value="${v}" ${p.control === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                        <label>Stance (when the game plays them)<select data-ogt-pfield="stance">
                            ${[['balanced', 'Balanced — attacks, heals under 50%'], ['aggressive', 'Aggressive — strongest ability, heals under 25%'], ['defensive', 'Defensive — guards when hurt'], ['support', 'Support — heals early, saves mana']].map(([v, l]) => `<option value="${v}" ${p.stance === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                        <label>Focus target<select data-ogt-pfield="focus"><option value="">Weakest enemy</option>
                            ${s.enemies.filter((e) => !e.defeated).map((e) => `<option value="${esc(e.id)}" ${p.focus === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
                    </div>` : ''}
                    <div class="ogt-rel-foot"><span></span><button class="ogt-btn small danger" data-ogt-act="pm-del">Remove from party</button></div>` : ''}
                </div>
            </div>`;
        }
        if (s.party.length < PARTY_MAX) {
            h += `<div class="ogt-section">ADD A COMPANION</div><div class="ogt-form">
                <label>Name<input id="ogt-pm-name" type="text" placeholder="e.g. Mira"></label>
                <label>Class<input id="ogt-pm-class" type="text" placeholder="e.g. Rogue"></label>
                <label>Level<input id="ogt-pm-level" type="number" min="1" max="20" value="${s.level}"></label>
                ${combat ? `<label>HP<input id="ogt-pm-hp" type="number" min="1" value="20"></label><label>${esc(G().terms.mana)}<input id="ogt-pm-mana" type="number" min="0" value="0"></label><label>AC<input id="ogt-pm-ac" type="number" min="5" max="25" value="12"></label>` : ''}
                <label>Skills (name rank, …)<input id="ogt-pm-skills" type="text" placeholder="Stealth 3, Lockpicking 2"></label>
            </div><button class="ogt-btn ogt-wide" data-ogt-act="add-pm">Add to party</button>`;
        }
        return h;
    }

    function questHtml(q) {
        const mark = q.status === 'active'
            ? `<button class="ogt-btn small" data-ogt-act="q-done" title="Complete">✓</button><button class="ogt-btn small" data-ogt-act="q-fail" title="Fail">✕</button>`
            : `<button class="ogt-btn small" data-ogt-act="q-reopen" title="Reopen">↺</button>`;
        return `<div class="ogt-quest ${q.status}" data-qid="${esc(q.id)}">
            <div class="ogt-quest-head"><span class="ogt-quest-title">${esc(q.title)}</span><span class="ogt-quest-btns">${mark}<button class="ogt-btn small" data-ogt-act="q-del" title="Delete">🗑</button></span></div>
            <div class="ogt-quest-meta"><span class="ogt-badge d-${normDiff(q.difficulty)}">${normDiff(q.difficulty)}</span>
                <span class="ogt-xpchip">${q.status === 'done' ? '+' + questReward(q) + ' XP earned' : q.status === 'failed' ? 'no reward' : questReward(q) + ' XP'}</span>
                ${(q.ms || 0) ? `<span class="ogt-xpchip">${q.ms}/${MILESTONE_MAX} milestones</span>` : ''}</div>
            ${q.desc ? `<div class="ogt-quest-desc">${esc(q.desc)}</div>` : ''}
            ${q.progress ? `<div class="ogt-quest-prog">▸ ${esc(q.progress)}</div>` : ''}
        </div>`;
    }

    function renderQuests(s) {
        const active = s.quests.filter((q) => q.status === 'active');
        const rest = s.quests.filter((q) => q.status !== 'active');
        let h = `<div class="ogt-section">ACTIVE QUESTS</div>`;
        h += active.length ? active.map(questHtml).join('') : `<div class="ogt-empty">No active quests.</div>`;
        if (rest.length) h += `<div class="ogt-section">FINISHED</div>${rest.map(questHtml).join('')}`;
        h += `<div class="ogt-form"><input id="ogt-new-q" placeholder="Quest title"><input id="ogt-new-qd" placeholder="Objective (optional)">
            <select id="ogt-new-qdiff">${Object.entries(DIFFICULTY).map(([k, v]) => `<option value="${k}" ${k === 'medium' ? 'selected' : ''}>${k} (${v} XP)</option>`).join('')}</select>
            <button class="ogt-btn ogt-wide" data-ogt-act="add-quest">Add quest</button></div>`;
        return h;
    }

    // ───────────────────────── dice rolls ─────────────────────────
    // The game rolls two d20s BEFORE each generation and hands them to the model (so it can't fudge).
    // The model chooses skill / DC / modifiers; we recompute the result from your real skill ranks and show a card.

    let pendingRoll = null;
    const testOn = (k) => !!(settings().testMode && settings()[k]);
    const d20 = () => {
        const forced = Math.round(num(settings().testMode ? settings().testDie : 0, 0));
        if (forced >= 1 && forced <= 20) return forced;
        const b = new Uint32Array(1); crypto.getRandomValues(b); return (b[0] % 20) + 1;
    };
    const hasLuck = (s) => testOn('testInfiniteLuck') || s.luck > 0;
    const spendLuck = (s) => { if (!testOn('testInfiniteLuck')) s.luck -= 1; };
    const OUTCOMES = {
        crit: 'Critical Success', strong: 'Strong Success', success: 'Success',
        fail: 'Failure', badfail: 'Bad Failure', critfail: 'Critical Failure',
    };

    function findSkill(s, name) {
        const q = slug(name || '');
        if (!q) return null;
        return s.skills.find((k) => k.id === q) || s.skills.find((k) => k.id.includes(q) || q.includes(k.id)) || null;
    }

    function resolveRoll(r, dice, s) {
        if (!r || typeof r !== 'object' || !dice) return null;
        const dc = clamp(Math.round(num(r.dc, 12)), 5, 30);
        const mod = clamp(Math.round(num(r.mod, 0)), -5, 5);
        const adv = Math.sign(num(r.adv, 0));
        const nat = adv > 0 ? Math.max(dice.a, dice.b) : adv < 0 ? Math.min(dice.a, dice.b) : dice.a;
        const sk = findSkill(s, r.skill);
        const ab = ABILITIES.includes(r.ability) ? r.ability : null; // raw ability check when no skill fits
        const who = checkActors(s, r);
        let bonus = sk ? skillBonus(s, sk) : (ab ? amod(s.stats?.[ab]) : 0);
        let skill = sk?.name || (ab ? `${AB_FULL[ab]}` : String(r.skill || 'Unskilled').slice(0, 30)), trained = !!sk, ability = sk ? abilityOf(sk) : ab;
        if (who.performer) { // a companion takes the check with their own skills and ability scores
            const info = memberSkillInfo(who.performer, r.skill, ab);
            ({ bonus, trained, ability } = info);
            skill = info.name || skill;
        }
        const rel = socialBonus(s, r.npc);
        const help = who.helper ? assistBonus(who.helper, r.skill) : 0;
        const total = nat + bonus + mod + rel + help;
        const outcome = nat === 20 ? 'crit' : nat === 1 ? 'critfail'
            : total >= dc ? (total >= dc + 5 ? 'strong' : 'success') : (total <= dc - 5 ? 'badfail' : 'fail');
        return {
            skill, trained, ability,
            npc: r.npc ? String(r.npc).slice(0, 30) : undefined, rel,
            byName: who.performer?.name, help, helpName: help ? who.helper.name : undefined,
            bonus, mod, adv, dice: [dice.a, dice.b], nat, total, dc, outcome, why: String(r.why || '').slice(0, 80),
        };
    }

    // ── companions taking or helping with skill checks ──
    /** Who rolls (a companion instead of you) and who assists, resolved from the ids saved on the check card. */
    function checkActors(s, r) {
        const performer = r.by && r.by !== 'player' ? s.party.find((p) => p.id === r.by) || null : null;
        const helper = r.assist ? s.party.find((p) => p.id === r.assist && p !== performer) || null : null;
        return { performer, helper };
    }
    function memberSkillInfo(p, skillName, abilityHint) {
        const q = slug(skillName || '');
        const k = q ? p.skills.find((x) => slug(x.name) === q) || p.skills.find((x) => slug(x.name).includes(q) || q.includes(slug(x.name))) : null;
        const ability = ABILITIES.includes(abilityHint) ? abilityHint : (SKILL_ABILITY[slug(k?.name || skillName || '')] || null);
        return { trained: !!k, name: k?.name, ability, bonus: (k ? k.rank : 0) + (ability ? amod(p.stats?.[ability]) : 0) };
    }
    /** An ally with the skill lends a hand: +1 per two ranks (1-3). One without it can't help. */
    function assistBonus(helper, skillName) {
        const info = memberSkillInfo(helper, skillName, null);
        const k = info.trained ? helper.skills.find((x) => x.name === info.name) : null;
        return k ? clamp(Math.ceil(k.rank / 2), 1, 3) : 0;
    }

    const pickNat = (dice, adv) => (adv > 0 ? Math.max(dice.a, dice.b) : adv < 0 ? Math.min(dice.a, dice.b) : dice.a);

    /** Player attack: d20 + proficiency + ability + weapon bonus vs the target's AC; on a hit roll weapon damage and hurt the tracked enemy. */
    /** To-hit bonus, damage dice and flavour for whoever is attacking: the player (no `by`) or a companion (`by` = member id). */
    function attackStats(s, byId, spell, dmgSpec, abilityName) {
        const p = byId && byId !== 'player' ? s.party.find((x) => x.id === byId) : null;
        if (p) {
            const wp = spell ? null : equippedIn(p.inv, 'weapon');
            const mod = amod(p.stats?.[spell ? 'int' : (wp?.ability || 'str')]); // weapons use STR or DEX, abilities use INT, like the player
            return {
                name: p.name, bonus: profBonus(p.level) + mod + (wp?.bonus || 0),
                dmgDice: spell ? (parseDice(dmgSpec, p.level) || parseDice('1d6')) : (parseDice(wp?.dmg, p.level) || parseDice('1d4')),
                extra: spell ? 0 : mod + (wp?.bonus || 0), how: spell ? (abilityName || 'a special ability') : (wp ? wp.name : 'unarmed'),
            };
        }
        const { w, ability, magic, bonus } = attackProfile(s, spell);
        return {
            name: s.name, bonus, dmgDice: spell ? (parseDice(dmgSpec, s.level) || parseDice('1d8')) : (parseDice(w?.dmg) || parseDice('1d2')),
            extra: spell ? 0 : amod(s.stats?.[ability]) + magic, how: spell ? (abilityName || genreOf(s).terms.special) : (w ? w.name : 'unarmed'),
        };
    }

    function resolveAttack(chk, dice, s) {
        const spell = !!chk.spell;
        const st = attackStats(s, chk.by, spell, chk.dmg, chk.abilityName);
        const { bonus, how } = st;
        const adv = Math.sign(num(chk.adv, 0)), mod = clamp(Math.round(num(chk.mod, 0)), -5, 5);
        const nat = pickNat(dice, adv), total = nat + bonus + mod;
        const ac = clamp(Math.round(num(chk.ac, 12)), 5, 25);
        const crit = nat === 20, hit = crit || (nat !== 1 && total >= ac);
        if (chk.cost) { // abilities cost mana whether or not they land
            const payer = ownerOf(s, chk.by || 'player');
            if (payer) payer.mana = Math.max(0, payer.mana - chk.cost);
        }
        let dmg = 0;
        if (hit) dmg = Math.max(1, rollDice(st.dmgDice, { crit, extra: st.extra }).total);
        const foe = findEnemy(s, chk.target);
        if (hit && foe) { foe.hp = Math.max(0, foe.hp - dmg); if (foe.hp === 0) foe.defeated = true; }
        const label = crit ? 'Critical Hit' : hit ? 'Hit' : nat === 1 ? 'Critical Miss' : 'Miss';
        const foeTxt = foe ? ` ${foe.name}: ${foe.hp}/${foe.hpMax} HP${foe.defeated ? ' — DEFEATED' : ''}.` : '';
        const adTxt = adv ? ` (${adv > 0 ? 'advantage' : 'disadvantage'})` : '';
        const costTxt = chk.cost ? ` (spent ${chk.cost} ${genreOf(s).terms.mana.toLowerCase()})` : '';
        logAttack(s, { side: 'ally', who: st.name, target: foe?.name || String(chk.target || 'target').slice(0, 30), nat, hit, crit, dmg, how });
        return {
            kind: 'attack', nat, total, dice: [dice.a, dice.b], adv, outcome: crit ? 'crit' : hit ? 'success' : nat === 1 ? 'critfail' : 'fail',
            title: chk.by && chk.by !== 'player' ? `${st.name} → ${chk.target || 'target'}` : `Attack · ${chk.target || 'target'}`, why: String(chk.why || '').slice(0, 80), label,
            line: `d20 ${nat} ${fmtMod(bonus + mod)} = ${total} vs AC ${ac}${hit ? ` · ${dmg} damage` : ''}${foe ? ` · ${foe.name} ${foe.hp}/${foe.hpMax}${foe.defeated ? ' ☠' : ''}` : ''}`,
            text: `${st.name}'s attack on ${chk.target || 'the target'} with ${how}${costTxt}: d20 ${nat}${adTxt} ${fmtMod(bonus + mod)} = ${total} vs AC ${ac} — ${label.toUpperCase()}${hit ? `, ${dmg} damage dealt (already applied by the game)` : ''}.${foeTxt}`,
        };
    }

    /** Enemy attack on the player: d20 + enemy attack bonus vs the player's AC; damage is applied to player HP by the game. */
    function resolveDefend(chk, dice, s) {
        const ally = chk.target && s.party.length ? findMember(s, chk.target) : null; // the enemy may be aiming at a party member
        const ac = ally ? ally.ac : computeAC(s);
        const victim = ally ? ally.name : s.name;
        const atk = clamp(Math.round(num(chk.atk, 3)), 0, 4 + s.level);
        const guarded = !!s.combat?.guard?.[ally ? `p:${ally.id}` : 'player']; // took the Defend action: attackers have disadvantage
        const adv = clamp(Math.sign(num(chk.adv, 0)) - (guarded ? 1 : 0), -1, 1), mod = clamp(Math.round(num(chk.mod, 0)), -5, 5);
        const nat = pickNat(dice, adv), total = nat + atk + mod;
        const crit = nat === 20, hit = crit || (nat !== 1 && total >= ac);
        const dd = parseDice(chk.dmg, s.level) || parseDice('1d6');
        let dmg = 0;
        if (hit) {
            dmg = Math.max(1, rollDice(dd, { crit }).total);
            if (ally) ally.hp = Math.max(0, ally.hp - dmg); else s.hp = Math.max(0, s.hp - dmg);
        }
        const hpNow = ally ? ally.hp : s.hp, hpMax = ally ? ally.hpMax : s.hpMax;
        const who = chk.enemy || 'The enemy';
        const label = crit ? 'Critical Hit' : hit ? 'Hit' : 'Miss';
        const down = hpNow === 0 ? ` ${victim} is at 0 HP and falls unconscious/dying.` : '';
        logAttack(s, { side: 'foe', who, target: victim, nat, hit, crit, dmg, how: 'attack' });
        return {
            kind: 'defend', nat, total, dice: [dice.a, dice.b], adv, outcome: crit ? 'critfail' : hit ? 'fail' : 'success',
            title: `${who} attacks ${ally ? victim : 'you'}`, why: String(chk.why || '').slice(0, 80), label,
            line: `d20 ${nat} ${fmtMod(atk + mod)} = ${total} vs ${ally ? victim + "'s" : 'your'} AC ${ac}${hit ? ` · ${ally ? victim : 'you'} take${ally ? 's' : ''} ${dmg}` : ''} · HP ${hpNow}/${hpMax}`,
            text: `${who} attacks ${victim}: d20 ${nat} ${fmtMod(atk + mod)} = ${total} vs AC ${ac} — ${label.toUpperCase()}${hit ? `, ${dmg} damage taken (already applied by the game; HP ${hpNow}/${hpMax})` : ''}.${down}`,
        };
    }

    const SOCIAL_RULES = `[Social — Charisma matters, but talking is not rolling]
- Ordinary conversation, reasonable requests to friendly NPCs and anything low-stakes simply happen — no check.
- Call for a check when an NPC has a real reason to resist and the result matters: persuading, haggling, bluffing, intimidating, seducing, performing, calming a crowd. Use Persuasion / Deception / Intimidation / Performance / Insight if the player has the skill; otherwise make it a raw ability check by omitting "skill" and giving "ability":"cha" (or "wis" to read someone, etc.).
- Name the target NPC with "npc":"Helga". The game adds that NPC's attitude to the roll (friendlier = easier, hostile = harder). DC by what is asked: 10 small favor, 14 notable, 17 risky or against their interest, 20+ betrays their loyalties.
- Afterwards reflect it in relationships ("rel"): a clear success warms them (+3..+10, more on a critical), a failure can cool them (-2..-8), a botched lie or insult can sour them sharply. Even a great roll can't make an NPC act wildly out of character.`;

    function checkBlock(s) {
        const sheet = s.skills.length ? s.skills.map((k) => `${k.name} ${fmtMod(skillBonus(s, k))}`).join(', ') : 'none (all checks are +0)';
        return `

[Checks — the player rolls their own dice]
When the player's action has real uncertainty AND a meaningful consequence for failing (an attack, sneaking past someone, persuading a resistant NPC, climbing, picking a lock, ${G().prompt.pressure}…), do NOT decide the outcome yourself. Narrate up to the moment of the attempt, STOP there, and request one check by putting it inside the SAME hidden tag you always append at the very end of the reply, e.g.
<!--OGT:{"check":{"skill":"Stealth","dc":15,"mod":0,"adv":0,"why":"slip past the guards"}}-->
The check must live ONLY inside that hidden <!--OGT:…--> comment. Never write it (or any JSON, "check:" or "dc") as visible text in the story.
- Pick the best-fitting skill from the player's sheet (the bonus already includes its governing ability). Player skills: ${sheet}. If none fits, omit "skill" and give "ability":"str|dex|con|int|wis|cha" for a raw ability check (bonus = that ability's modifier); with neither it is +0.
- DC: 8 easy, 12 routine, 15 moderate, 18 hard, 22 heroic. For strong situational factors add "mod" (-5..+5) and "adv":1 (advantage) / -1 (disadvantage).
- The player then clicks to roll. You will receive the result — either as a [ROLL RESULT] block or a player message beginning with [ROLL] — giving the total, the DC and the outcome (Critical Success, Strong Success, Success, Failure, Bad Failure or Critical Failure). Narrate EXACTLY that outcome honestly and let it matter; never ask for the same check again. If a result has no DC, judge the total against a fair DC for what they attempted.
- Safe, trivial or purely conversational actions need no check — just narrate. At most one check per turn. Never state the dice numbers in your narration.${settings().luckRerolls ? '\n- Luck: the player may spend a Luck point to reroll a FAILED check before you narrate it; you only ever receive the final result (a note says if it was rerolled). Do not offer or mention rerolls yourself. Very rarely — for genuinely inspired roleplay or a heroic gamble — you may grant 1 Luck by adding "luck":1 to the tag.' : ''}

${SOCIAL_RULES}${G().prompt.socialExtra || ''}${hasCombat(s) ? `

[Combat — the game resolves every attack and tracks enemy HP]
- Register each enemy the moment it appears, with sensible stats: <!--OGT:{"enemies":{"add":[{"name":"${G().prompt.enemyExample}","hp":9,"ac":13,"atk":4,"dmg":"1d6+1"}]}}--> ("atk" = its to-hit bonus +2..+8, "dmg" = damage dice per hit, scaled to its threat — the game uses them to play its turns).${settings().autoEnemies ? ' ENEMY TURNS ARE AUTOMATIC: the game rolls every enemy attack itself and sends you the results as "TURNS RESOLVED BY THE GAME: …" lines inside a [ROLL] result. Narrate exactly those results; NEVER request "defend" checks, invent enemy attacks or damage, or report "initiative.next" (the game advances the turns itself).' : ''} Typical AC: ${G().prompt.acGuide}. Use "enemies":{"clear":true} when the fight ends.
- When the PLAYER attacks (${G().prompt.attackWho}), stop and request: "check":{"kind":"attack","target":"${G().prompt.enemyExample}","ac":13,"why":"the attack, in a few words"} (${G().prompt.attackSpell}). The game rolls the hit and damage with their real weapon and applies it to that enemy.
- When an ENEMY attacks the player, stop and request: "check":{"kind":"defend","enemy":"${G().prompt.enemyExample}","atk":4,"dmg":"1d6+1","why":"how it strikes"} (atk +2..+8, dmg by threat). The game rolls against the player's AC and applies the damage to their HP itself — NEVER also report "hp" for combat damage.${settings().trackParty && s.party.length ? ' To aim the enemy at a party member instead, add "target":"<their name>" — the game then rolls against THEIR armor and applies the damage to THEM (never also report their hp for that attack).' : ''}
- Initiative: the tracker lists a turn order (see "initiative" in the state). Run the fight in that order, one combatant's action at a time — the PLAYER plays their own turn, and any companion with "control":"player", through the game's action bar. Companions with "control":"game"${settings().autoEnemies ? ' and all enemies' : ''} are played by the game and reported to you as "TURNS RESOLVED BY THE GAME" lines. You narrate ${settings().autoEnemies ? 'what those results say and the outcomes you receive' : 'ENEMY turns and the outcomes you receive'}; never invent an attack or action for the player or a companion, and stop when a player-controlled turn comes up. After you narrate, report how many turns passed with "initiative":{"next":N} in the tag (N = turns advanced, 0-6); the game keeps the order and round count. Enemies you add mid-fight join the order automatically.
- Attacks with no check: an enemy attack you narrate without a "defend" check can be logged with "attacks":[{"who":"<enemy name>","target":"<who it hit>","hit":true,"dmg":N}] — log only; apply the damage to a party member through "party.update" hp. The player and every companion resolve their own attacks through the game (you play neither), so never report those.
- The result tells you hit/miss, damage dealt and the enemy's remaining HP. Narrate it exactly; a DEFEATED enemy is dead or out of the fight. Skill checks stay "kind":"skill" (or omit kind). One check per turn, so run a fight one attack at a time.
- Never invent the player's gear: they carry only what the sheet's "gear" lists. Give loot/purchases with "inv.add" (and "inv.remove" when something is used up), never in prose alone.` : `

[No combat] This game has no combat rules. Never request "attack" or "defend" checks. Conflict here is social and personal: arguments, rivalries, secrets, embarrassment, loyalty and trust. Failing a check costs reputation, trust or an opportunity — it never injures anyone.`}`;
    }

    function diceBlock(s) {
        if (!settings().dice) return '';
        if (settings().rollMode === 'manual') return checkBlock(s);
        if (!pendingRoll) return '';
        const sheet = s.skills.length ? s.skills.map((k) => `${k.name} ${fmtMod(skillBonus(s, k))}`).join(', ') : 'none (all checks are +0)';
        return `

[Dice — rolled by the game for this turn. Do not reroll, invent or alter them.]
d20 #1 = ${pendingRoll.a}, d20 #2 = ${pendingRoll.b}
When the player's action has real uncertainty AND a meaningful consequence for failing (an attack, sneaking past someone, persuading a resistant NPC, climbing, picking a lock, ${G().prompt.pressure}…), resolve it as ONE skill check. Safe, trivial or purely conversational actions need no roll.
1. Choose the best-fitting skill from the player's sheet (bonus = its rank; no fitting skill = +0). Player skills: ${sheet}.
2. Choose a DC: 8 easy, 12 routine, 15 moderate, 18 hard, 22 heroic. For strong situational factors add "mod" (-5..+5), and "adv":1 for advantage / -1 for disadvantage.
3. nat = die #1 (advantage: the higher die; disadvantage: the lower). total = nat + skill bonus + mod. Natural 20 always succeeds, natural 1 always fails; otherwise total >= DC succeeds. Beating the DC by 5+ is a strong success; missing by 5+ is a bad failure.
4. Narrate the outcome honestly and let it matter. Never fudge the result and never state the numbers in prose — the game shows the roll.
5. Report it inside the hidden end-of-reply tag, e.g. <!--OGT:{"roll":{"skill":"Stealth","dc":15,"mod":0,"adv":0,"why":"slip past the guards"}}-->, never as visible text. At most one roll per turn; omit "roll" if no check was warranted.

${SOCIAL_RULES}${G().prompt.socialExtra || ''}`;
    }

    function rollHtml(r, kind = 'roll', sig = JSON.stringify(r), actions = '') {
        const reTxt = r.rerolled != null ? ` · 🍀 rerolled${r.rerolls > 1 ? ` ×${r.rerolls}` : ''} (was ${r.rerolled})` : '';
        if (r.kind === 'attack' || r.kind === 'defend') {
            return `<div class="ogt-roll ogt-card out-${r.outcome}" data-kind="${kind}" data-sig="${esc(sig)}">
                <div class="ogt-die">${r.nat}</div>
                <div class="ogt-roll-main">
                    <div class="ogt-roll-title">${esc(r.title)}${r.why ? `<span> · ${esc(r.why)}</span>` : ''}</div>
                    <div class="ogt-roll-math">${esc(r.line)}${esc(reTxt)}</div>
                </div>
                <div class="ogt-roll-out">${esc(r.label)}</div>${actions}
            </div>`;
        }
        const sign = (n) => (n >= 0 ? `+ ${n}` : `− ${Math.abs(n)}`);
        const diceTxt = r.adv ? `d20 [${r.dice[0]}, ${r.dice[1]}] → ${r.nat} (${r.adv > 0 ? 'adv' : 'dis'})` : `d20 ${r.nat}`;
        const parts = [diceTxt, `${sign(r.bonus)} ${r.trained ? 'skill' : r.ability ? AB_NAME[r.ability] : 'untrained'}`];
        if (r.help) parts.push(`${sign(r.help)} ${r.helpName}'s help`);
        if (r.rel) parts.push(`${sign(r.rel)} ${r.npc ? r.npc + "'s" : 'their'} attitude`);
        if (r.mod) parts.push(`${sign(r.mod)} situation`);
        return `<div class="ogt-roll ogt-card out-${r.outcome}" data-kind="${kind}" data-sig="${esc(sig)}">
            <div class="ogt-die">${r.nat}</div>
            <div class="ogt-roll-main">
                <div class="ogt-roll-title">${r.byName ? esc(r.byName) + ': ' : ''}${esc(r.skill)} check${r.why ? `<span> · ${esc(r.why)}</span>` : ''}</div>
                <div class="ogt-roll-math">${parts.join(' ')} = <b>${r.total}</b> vs DC ${r.dc}${esc(reTxt)}</div>
            </div>
            <div class="ogt-roll-out">${OUTCOMES[r.outcome]}</div>${actions}
        </div>`;
    }

    /** Buttons shown on a failed roll while the narrator is still waiting (accepted === false). */
    function decisionHtml(chk, live) {
        if (!live || chk.accepted !== false) return '';
        const luck = testOn('testInfiniteLuck') ? '∞' : getState().luck;
        return `<div class="ogt-decide"><button class="ogt-reroll-btn" ${hasLuck(getState()) ? '' : 'disabled'} title="Spend 1 Luck and roll again — you must keep the new result">🍀 Reroll · ${luck}</button>
            <button class="ogt-accept-btn">Accept</button></div>`;
    }

    /** Idempotently put a roll card above each message that has one (DOM only — never saved into the chat text). */
    function decorateRolls() {
        const c = ctx();
        const on = settings().enabled && settings().dice;
        const last = c.chat.length - 1;
        document.querySelectorAll('#chat .mes').forEach((el) => {
            const id = +el.getAttribute('mesid');
            const ex = on ? c.chat[id]?.extra : null;
            const want = {
                roll: ex?.ogt_roll ? { data: ex.ogt_roll, place: 'beforebegin' } : null,   // auto-mode result: above the reply
                check: ex?.ogt_check ? { data: ex.ogt_check, place: 'afterend' } : null,    // click-to-roll: below the reply
            };
            for (const kind of ['roll', 'check']) {
                const cur = el.querySelector(`.ogt-card[data-kind="${kind}"]`);
                const w = want[kind];
                if (!w) { cur?.remove(); continue; }
                const live = kind === 'check' && id === last && !rolling;
                const sig = JSON.stringify(w.data) + (kind === 'check' ? `|${live}` : '');
                if (cur && cur.dataset.sig === sig) continue;
                cur?.remove();
                const html = kind === 'roll' ? rollHtml(w.data, 'roll', sig)
                    : w.data.result ? rollHtml(w.data.result, 'check', sig, decisionHtml(w.data, live)) : checkHtml(w.data, live, sig);
                el.querySelector('.mes_text')?.insertAdjacentHTML(w.place, html);
            }
        });
    }

    // ── click-to-roll ──
    let rolling = false;

    function checkHtml(k, live, sig) {
        const sign = (n) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);
        const extra = [k.mod ? `${sign(k.mod)} situation` : '', k.adv ? (k.adv > 0 ? 'advantage' : 'disadvantage') : ''].filter(Boolean).join(' · ');
        let title, math, btn, rollerSel = '';
        if (k.kind === 'attack') {
            title = k.byName ? `${k.byName} → ${k.target}` : `Attack · ${k.target}`;
            math = `${sign(k.bonus + k.mod)} to hit · AC ${k.ac}${k.abilityName ? ' · ' + k.abilityName : k.spell ? ' · ' + G().terms.special : ''}${k.cost ? ` · ${k.cost} ${G().terms.mana}` : ''}`; btn = 'Roll attack';
        } else if (k.kind === 'defend') {
            const ally = k.target ? findMember(getState(), k.target) : null;
            title = `${k.enemy} attacks ${ally ? ally.name : 'you'}`; math = `${sign(k.atk + k.mod)} to hit · ${ally ? ally.name + "'s" : 'your'} AC ${ally ? ally.ac : computeAC(getState())}`; btn = 'Defend';
        } else {
            const st = getState(), who = checkActors(st, k);
            let { bonus, trained, ability } = k;
            if (who.performer) ({ bonus, trained, ability } = memberSkillInfo(who.performer, k.skill, ABILITIES.includes(k.ability) ? k.ability : null));
            const help = who.helper ? assistBonus(who.helper, k.skill) : 0;
            const src = trained ? `skill${ability ? ` (${AB_NAME[ability]})` : ''}` : ability ? AB_NAME[ability] : 'untrained';
            const relTxt = k.rel ? ` · ${sign(k.rel)} ${k.npc ? k.npc + "'s" : 'their'} attitude` : '';
            title = `${who.performer ? who.performer.name + ': ' : ''}${k.skill} check`;
            math = `${sign(bonus)} ${src}${help ? ` · ${sign(help)} ${who.helper.name}'s help` : ''}${relTxt}${extra ? ' · ' + extra : ''} · DC ${k.dc}`; btn = 'Roll d20';
            // pick who rolls (a companion with a better bonus can take it) and who lends a hand
            if (live && !k.result && settings().trackParty && st.party.length) {
                const hint = ABILITIES.includes(k.ability) ? k.ability : null;
                const helpers = st.party.filter((p) => p.id !== k.by && assistBonus(p, k.skill) > 0);
                rollerSel = `<div class="ogt-decide"><label class="ogt-target">Rolled by <select class="ogt-roller-sel"><option value="player">${esc(st.name)} (you) ${sign(k.bonus)}</option>${st.party.map((p) => `<option value="${esc(p.id)}" ${k.by === p.id ? 'selected' : ''}>${esc(p.name)} ${sign(memberSkillInfo(p, k.skill, hint).bonus)}</option>`).join('')}</select></label>
                    ${helpers.length ? `<label class="ogt-target">Help <select class="ogt-assist-sel"><option value="">no one</option>${helpers.map((p) => `<option value="${esc(p.id)}" ${k.assist === p.id ? 'selected' : ''}>${esc(p.name)} ${sign(assistBonus(p, k.skill))}</option>`).join('')}</select></label>` : ''}</div>`;
            }
        }
        // the player picks who to hit (the narrator's suggestion is pre-selected)
        const foes = k.kind === 'attack' && live && !k.result ? getState().enemies.filter((e) => !e.defeated) : [];
        const targetSel = foes.length > 1 || (foes.length === 1 && foes[0].name !== k.target)
            ? `<div class="ogt-decide"><label class="ogt-target">Target <select class="ogt-target-sel">${foes.map((e) => `<option value="${esc(e.id)}" ${slug(k.target) === e.id ? 'selected' : ''}>${esc(e.name)} · AC ${e.ac} · ${e.hp}/${e.hpMax}</option>`).join('')}</select></label></div>` : '';
        const advBtn = live && canSpendAdv(k, getState())
            ? `<div class="ogt-decide"><button class="ogt-adv-btn" title="Spend 1 Luck before rolling">🍀 ${k.kind === 'defend' ? 'Disadvantage on attacker' : 'Advantage'} · ${testOn('testInfiniteLuck') ? '∞' : getState().luck}</button></div>` : '';
        return `<div class="ogt-roll ogt-card ogt-check" data-kind="check" data-sig="${esc(sig)}">
            <div class="ogt-die">d20</div>
            <div class="ogt-roll-main">
                <div class="ogt-roll-title">${esc(title)}${k.why ? `<span> · ${esc(k.why)}</span>` : ''}</div>
                <div class="ogt-roll-math">${esc(math)}</div>
            </div>
            <button class="ogt-check-btn" ${live ? '' : 'disabled'}>${live ? btn : 'Expired'}</button>${rollerSel}${targetSel}${advBtn}
        </div>`;
    }

    const isGenerating = () => { const st = document.getElementById('mes_stop'); return !!st && getComputedStyle(st).display !== 'none'; };

    /** Put a message in the chat as the player and send it (or just fill the box, per setting). */
    function sendAsPlayer(text) {
        const ta = document.getElementById('send_textarea');
        if (!ta) return;
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send_but')?.click();
    }

    /** Hand a finished roll to the narrator. Hidden by default: the result rides along in the prompt and we just trigger a reply. */
    async function deliverRoll(text) {
        if (testOn('testNoDeliver')) return window.toastr?.info('Test mode: roll result not sent to the narrator.', APP_NAME);
        if (!settings().showRollMsg) {
            const run = ctx().executeSlashCommandsWithOptions;
            if (run) {
                refreshPrompt(); // makes the pending result part of the next prompt
                try { await run('/trigger'); return; } catch (e) { console.warn(`[${MODULE}] /trigger failed, falling back to a visible message`, e); }
            }
        }
        sendAsPlayer(text); // visible fallback (or user preference)
    }

    /** The most recent roll result the narrator hasn't answered yet (derived from the chat, so swipes/regens keep it). */
    function pendingResultText() {
        const chat = ctx().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const x = chat[i].extra;
            if (x?.ogt_quick) return x.ogt_quick;
            const r = x?.ogt_check?.result;
            if (r && x.ogt_check.accepted !== false) return rollMessage(r, checkLabel(r, x.ogt_check)) + (x.ogt_check.after ? ` ${x.ogt_check.after}` : '');
            if (chat[i].is_user) return '';
        }
        return '';
    }

    function resultBlock() {
        if (!settings().dice || settings().showRollMsg) return '';
        const t = pendingResultText();
        return t ? `

[ROLL RESULT — the player just rolled; this resolves your requested check]
${t.replace(/^\[ROLL\]\s*/, '')}
Narrate exactly this outcome now, honestly, and let it matter. Do not request the same check again and do not state the numbers in the story.` : '';
    }

    const OUTCOME_TXT = { ...OUTCOMES };
    function rollMessage(res, label) {
        const rr = res.rerolled != null ? ` (the player spent Luck to reroll${res.rerolls > 1 ? ` ${res.rerolls} times` : ''}; the previous d20 was ${res.rerolled} — this is the final result)` : '';
        if (res.text) return `[ROLL] ${res.text}${rr}`;
        const bonus = res.bonus ? ` ${res.bonus >= 0 ? '+' : '−'} ${Math.abs(res.bonus)} ${res.trained ? 'skill' : res.ability ? AB_NAME[res.ability] : ''}`.trimEnd() : '';
        const mod = (res.help ? ` + ${res.help} ${res.helpName}'s help` : '')
            + (res.rel ? ` ${res.rel >= 0 ? '+' : '−'} ${Math.abs(res.rel)} ${res.npc ? res.npc + "'s" : 'their'} attitude` : '')
            + (res.mod ? ` ${res.mod >= 0 ? '+' : '−'} ${Math.abs(res.mod)} situation` : '');
        const die = res.adv ? `d20 [${res.dice[0]}, ${res.dice[1]}] → ${res.nat} (${res.adv > 0 ? 'advantage' : 'disadvantage'})` : `d20 ${res.nat}`;
        const dc = res.dc == null ? '' : ` vs DC ${res.dc} — ${OUTCOME_TXT[res.outcome]}`;
        return `[ROLL] ${label}: ${die}${bonus}${mod} = ${res.total}${dc}.${rr}`;
    }

    // ── luck & rerolls ──
    // A failed roll can be rerolled by spending a Luck point BEFORE the narrator describes it (the new roll must be kept).
    const BAD_OUTCOMES = ['fail', 'badfail', 'critfail'];
    const luckOn = () => settings().luckRerolls;
    const checkLabel = (res, chk) => `${res.byName ? res.byName + "'s " : ''}${res.skill} check${chk.why ? ` (${chk.why})` : ''}${res.byName ? ' — a companion took this check instead of the player' : ''}`;

    function resolveCheck(chk, dice, state) {
        return chk.kind === 'attack' ? resolveAttack(chk, dice, state)
            : chk.kind === 'defend' ? resolveDefend(chk, dice, state)
                : resolveRoll(chk, dice, state);
    }
    const isCombat = (chk) => chk.kind === 'attack' || chk.kind === 'defend';

    /** Spin the die on a card, then resolve. Returns the live check or null if the click isn't valid. */
    function locateCheck(btn, wantPending) {
        const id = +btn.closest('.mes')?.getAttribute('mesid');
        const c = ctx();
        const chk = c.chat[id]?.extra?.ogt_check;
        if (!chk || id !== c.chat.length - 1) return null;
        if (wantPending ? chk.accepted !== false : !!chk.result) return null;
        if (isGenerating()) { window.toastr?.info('Wait for the reply to finish first.', APP_NAME); return null; }
        return chk;
    }
    async function spinDie(btn, label) {
        rolling = true;
        btn.disabled = true; btn.textContent = label;
        const die = btn.closest('.ogt-card')?.querySelector('.ogt-die');
        const spin = setInterval(() => { if (die) die.textContent = 1 + Math.floor(Math.random() * 20); }, 55);
        await new Promise((r) => setTimeout(r, 750));
        clearInterval(spin);
    }

    async function doCheckRoll(btn) {
        if (rolling) return;
        const chk = locateCheck(btn, false);
        if (!chk) return;
        if (chk.cost) {
            const payer = ownerOf(getState(), chk.by || 'player');
            if (!payer || payer.mana < chk.cost) return notify('warning', `${payer?.name || 'They'} need${payer ? 's' : ''} ${chk.cost} ${G().terms.mana.toLowerCase()} for that.`);
        }
        await spinDie(btn, 'Rolling…');

        const c = ctx(), state = getState();
        // so a reroll can undo combat damage, spent mana, the log entry and any change to the turn order
        chk.pre = { hp: state.hp, mana: state.mana, enemies: clone(state.enemies), party: clone(state.party), log: clone(state.log), combat: clone(state.combat ?? null) };
        const res = resolveCheck(chk, { a: d20(), b: d20() }, state);
        chk.result = res;
        rolling = false;
        // offer a Luck reroll on a bad outcome; otherwise the result goes straight to the narrator
        const offer = luckOn() && hasLuck(state) && BAD_OUTCOMES.includes(res.outcome);
        chk.accepted = !offer;
        if (chk.luckAdv) res.luckAdv = true;
        if (!offer) delete chk.pre;
        if (isCombat(chk)) persist({ manual: true }); else scheduleSave();
        decorateRolls();
        if (!offer) { endActionTurn(chk); deliverRoll(finalMsg(chk)); }
    }

    /** A check created from the action bar ends that combatant's turn once its result is final (accepted or out of rerolls). */
    function endActionTurn(chk) {
        if (!chk.turn || chk.turnDone) return;
        chk.turnDone = true;
        const s = getState();
        nextTurn(s);
        chk.after = autoTurnsText(s, { enemies: !!settings().autoEnemies }) || undefined; // turns the game played next, told to the narrator with this result
        persist({ manual: true });
    }
    const finalMsg = (chk) => rollMessage(chk.result, checkLabel(chk.result, chk)) + (chk.after ? ` ${chk.after}` : '');

    async function doReroll(btn) {
        if (rolling) return;
        const chk = locateCheck(btn, true);
        const state = getState();
        if (!chk || !hasLuck(state)) return;
        await spinDie(btn, 'Rerolling…');

        const prev = chk.result.nat;
        spendLuck(state);
        if (chk.pre) { // undo the previous roll's damage
            state.hp = chk.pre.hp; state.mana = chk.pre.mana ?? state.mana; state.enemies = clone(chk.pre.enemies); state.party = clone(chk.pre.party || state.party);
            state.log = clone(chk.pre.log || state.log); state.combat = clone(chk.pre.combat ?? null);
        }
        const res = resolveCheck(chk, { a: d20(), b: d20() }, state);
        res.rerolled = prev;
        res.rerolls = (chk.result.rerolls || 0) + 1;
        chk.result = res;
        rolling = false;
        // still a bad result and Luck left: keep offering rerolls (each one costs a point and must be kept)
        const again = luckOn() && hasLuck(state) && BAD_OUTCOMES.includes(res.outcome);
        chk.accepted = !again;
        if (!again) delete chk.pre;
        persist({ manual: true });
        decorateRolls();
        if (!again) { endActionTurn(chk); deliverRoll(finalMsg(chk)); }
    }

    /** Spend 1 Luck before rolling: advantage on your own check/attack (cancels disadvantage), or disadvantage on an enemy's attack. */
    function advStep(chk) { return chk.kind === 'defend' ? -1 : 1; }
    function canSpendAdv(chk, state) {
        if (!luckOn() || !hasLuck(state) || chk.result) return false;
        const adv = Math.sign(num(chk.adv, 0));
        return advStep(chk) > 0 ? adv < 1 : adv > -1;
    }
    function doAdvantage(btn) {
        if (rolling) return;
        const chk = locateCheck(btn, false);
        const state = getState();
        if (!chk || !canSpendAdv(chk, state)) return;
        spendLuck(state);
        chk.adv = clamp(Math.sign(num(chk.adv, 0)) + advStep(chk), -1, 1);
        chk.luckAdv = true;
        persist({ manual: true });
        render();
        decorateRolls();
    }

    function doAccept(btn) {
        if (rolling) return;
        const chk = locateCheck(btn, true);
        if (!chk) return;
        chk.accepted = true; delete chk.pre;
        scheduleSave();
        decorateRolls();
        endActionTurn(chk);
        deliverRoll(finalMsg(chk));
    }

    /** Roll a skill on your own initiative (no DC — the narrator judges the total). */
    function quickRoll(skill) {
        if (isGenerating()) return window.toastr?.info('Wait for the reply to finish first.', APP_NAME);
        const nat = d20();
        const bonus = skillBonus(getState(), skill);
        const res = { skill: skill.name, trained: true, bonus, mod: 0, adv: 0, dice: [nat, nat], nat, total: nat + bonus, dc: null, outcome: null };
        notify('info', `${skill.name}: d20 ${nat} ${fmtMod(bonus)} = ${res.total}`, '🎲 Roll');
        const text = rollMessage(res, `${skill.name} (rolled on my own initiative)`);
        const c = ctx();
        const last = c.chat[c.chat.length - 1];
        if (last && !settings().showRollMsg) { last.extra = last.extra || {}; last.extra.ogt_quick = text; scheduleSave(); }
        deliverRoll(text);
    }
    // ───────────────────────── combat action bar ─────────────────────────
    // On a player-side turn (you or a companion you control) the Character tab shows that combatant's actions. Attacks and
    // damaging abilities become normal roll cards (so Luck, advantage and rerolls all work); everything else resolves at once.
    // Either way the turn passes to the next combatant when the action is final, and the result goes to the narrator.
    let actSel = { foe: '', ally: 'player', item: '' };

    /** Whoever's turn it is, if the player controls them: {id, ref (the sheet or member), name, kind}. */
    function turnHolder(s) {
        const o = s.combat?.order[s.combat.turn];
        if (!o) return null;
        if (o.kind === 'player') return { id: 'player', ref: s, name: s.name, kind: 'player' };
        if (o.kind === 'party') {
            const p = s.party.find((x) => `p:${x.id}` === o.id);
            return p && isPlayed(p) ? { id: p.id, ref: p, name: p.name, kind: 'party' } : null;
        }
        return null;
    }
    /** Do you play this companion's turns (action bar), or does the game (tactics)? Per-ally setting, defaulting to the global one. */
    const isPlayed = (p) => (p.control === 'me' ? true : p.control === 'auto' ? false : !!settings().allyControl);
    const bagFor = (s, id) => ownerOf(s, id)?.inv || [];
    const usableItems = (bag) => bag.filter((i) => (i.type === 'potion' || i.type === 'consumable') && (i.heal || i.mana));
    const combatIdOf = (h) => (h.id === 'player' ? 'player' : `p:${h.id}`);

    function actionGuard() {
        const s = getState(), h = turnHolder(s);
        if (!h) { notify('info', "It isn't a turn you control."); return null; }
        if (isGenerating()) { notify('info', 'Wait for the reply to finish first.'); return null; }
        return { s, h };
    }

    /** Weapon attack (no abilityId) or a damaging ability: puts a roll card on the newest message. */
    function startAttackAction(abilityId) {
        const g = actionGuard();
        if (!g) return;
        const { s, h } = g;
        const ability = abilityId ? h.ref.abilities?.find((a) => a.id === abilityId) : null;
        const foe = s.enemies.find((e) => e.id === actSel.foe && !e.defeated) || s.enemies.find((e) => !e.defeated);
        if (!foe) return notify('info', 'There is no enemy to attack.');
        if (ability && h.ref.mana < ability.cost) return notify('warning', `${h.name} needs ${ability.cost} ${G().terms.mana.toLowerCase()} for ${ability.name}.`);
        const last = ctx().chat[ctx().chat.length - 1];
        if (!last) return notify('warning', 'Send a message first.');
        const open = last.extra?.ogt_check;
        if (open && (!open.result || open.accepted === false)) return notify('info', 'Finish the roll that is already waiting first.');
        const st = attackStats(s, h.id, !!ability, ability?.dmg, ability?.name);
        last.extra = last.extra || {};
        delete last.extra.ogt_roll;
        last.extra.ogt_check = {
            mod: 0, adv: 0, why: ability ? ability.name : st.how, kind: 'attack', spell: !!ability, target: foe.name, ac: foe.ac, bonus: st.bonus,
            dmg: ability?.dmg, by: h.id, byName: h.name, abilityName: ability?.name, cost: ability?.cost || 0, turn: true,
        };
        persist({ manual: true });
        decorateRolls();
    }

    /** An action with no roll card: record it, pass the turn, and tell the narrator what happened. */
    function finishAction(text) {
        const s = getState();
        nextTurn(s);
        sendGameText(s, text, autoTurnsText(s, { enemies: !!settings().autoEnemies })); // game-played allies (and enemies, if auto-play is on) go now
    }

    /** Record game-resolved text for the narrator (result + any automatic turns after it), save, and trigger the reply. */
    function sendGameText(s, text, after = '') {
        const last = ctx().chat[ctx().chat.length - 1];
        const msg = `[ROLL] ${text}${after ? ' ' + after : ''}`;
        if (last && !settings().showRollMsg) { last.extra = last.extra || {}; last.extra.ogt_quick = msg; }
        persist({ manual: true });
        deliverRoll(msg);
    }

    /** "Run enemy turns" button: let the game play the turns until it is yours again. */
    function runTurnsNow() {
        if (isGenerating()) return notify('info', 'Wait for the reply to finish first.');
        const s = getState();
        const t = autoTurnsText(s);
        if (!t) return notify('info', 'No automatic turns to play right now.');
        sendGameText(s, t);
    }

    function healAction(abilityId) {
        const g = actionGuard();
        if (!g) return;
        const { s, h } = g;
        const ab = h.ref.abilities?.find((a) => a.id === abilityId);
        if (!ab) return;
        if (h.ref.mana < ab.cost) return notify('warning', `${h.name} needs ${ab.cost} ${G().terms.mana.toLowerCase()} for ${ab.name}.`);
        const t = ownerOf(s, actSel.ally) || s;
        h.ref.mana -= ab.cost;
        const before = t.hp;
        t.hp = Math.min(t.hpMax, t.hp + rollDice(parseDice(ab.dmg, h.ref.level) || parseDice('1d8')).total);
        finishAction(`${h.name} used ${ab.name} on ${t === h.ref ? 'themself' : t.name}: restored ${t.hp - before} HP (HP ${t.hp}/${t.hpMax}); spent ${ab.cost} ${G().terms.mana.toLowerCase()}.`);
    }

    function itemAction() {
        const g = actionGuard();
        if (!g) return;
        const { s, h } = g;
        const [iid, itype] = String(actSel.item || '').split('|');
        const bag = bagFor(s, h.id);
        const it = bag.find((x) => x.id === iid && x.type === itype);
        if (!it) return notify('info', 'Pick an item first.');
        const t = ownerOf(s, actSel.ally) || s, parts = [];
        if (it.heal) { const b = t.hp; t.hp = Math.min(t.hpMax, t.hp + rollDice(parseDice(it.heal)).total); parts.push(`restored ${t.hp - b} HP`); }
        if (it.mana && t.manaMax) { const b = t.mana; t.mana = Math.min(t.manaMax, t.mana + rollDice(parseDice(it.mana)).total); parts.push(`restored ${t.mana - b} ${G().terms.mana.toLowerCase()}`); }
        it.qty -= 1;
        if (it.qty <= 0) bag.splice(bag.indexOf(it), 1);
        finishAction(`${h.name} used ${it.name}${t === h.ref ? '' : ` on ${t.name}`}${parts.length ? ': ' + parts.join(', ') : ''}.`);
    }

    function defendAction() {
        const g = actionGuard();
        if (!g) return;
        const { s, h } = g;
        s.combat.guard = { ...(s.combat.guard || {}), [combatIdOf(h)]: true };
        finishAction(`${h.name} takes a defensive stance — attacks against them have disadvantage until their next turn.`);
    }

    function fleeAction() {
        const g = actionGuard();
        if (!g) return;
        const { s, h } = g;
        const live = s.enemies.filter((e) => !e.defeated).length, dc = clamp(8 + 2 * live, 10, 20);
        const nat = d20(), mod = amod(s.stats?.dex), total = nat + mod;
        const ok = nat === 20 || (nat !== 1 && total >= dc);
        if (ok) s.enemies = []; // the fight is over; the tracker clears itself
        finishAction(`${h.name} tries to lead the party out of the fight: d20 ${nat} ${fmtMod(mod)} = ${total} vs DC ${dc} — ${ok ? 'THE PARTY ESCAPES, combat is over' : 'FAILED, they are still in the fight'}.`);
    }

    function customAction() {
        const g = actionGuard();
        if (!g) return;
        const el = document.getElementById('ogt-act-custom');
        const t = el?.value.trim();
        if (!t) return;
        el.value = '';
        sendAsPlayer(`(${g.h.name}'s turn) ${t}`);
    }

    let decorateTimer = null;
    const scheduleDecorate = () => { clearTimeout(decorateTimer); decorateTimer = setTimeout(decorateRolls, 80); };

    // ───────────────────────── character creator ─────────────────────────

    const CLASSES = [
        { id: 'warrior', name: 'Warrior', tag: 'Steel, grit and a shield wall.', hp: 34, mana: 2, grow: [7, 1], skills: [['Swordsmanship', 3], ['Intimidation', 1], ['Survival', 1]],
            traits: 'Trained soldier. Wears heavy armor and wields shields and blades with ease, shrugs off blows, and is hard to rattle. Clumsy at subtlety; has no real magic.' },
        { id: 'rogue', name: 'Rogue', tag: 'Shadows, locks and quick knives.', hp: 24, mana: 4, grow: [5, 2], skills: [['Stealth', 3], ['Lockpicking', 2], ['Deception', 1]],
            traits: 'Light, fast and sneaky. Strikes from surprise for outsized damage, but is fragile in a straight fight and fights dirty.' },
        { id: 'mage', name: 'Mage', tag: 'Raw mana and forbidden pages.', hp: 18, mana: 16, grow: [3, 5], skills: [['Magic', 3], ['Lore', 2], ['Alchemy', 1]],
            traits: 'Scholar-caster. Spells and rituals cost mana (report as negative mana). Powerful at range and with knowledge, physically frail, exhausted when mana runs dry.' },
        { id: 'cleric', name: 'Cleric', tag: 'Faith, mending and wards.', hp: 26, mana: 10, grow: [5, 4], skills: [['Medicine', 2], ['Lore', 1], ['Persuasion', 1], ['Magic', 1]],
            traits: 'Devout healer. Divine prayers (heal, ward, smite the unholy) cost mana. Respected by the faithful, resented by cults and the undead.' },
        { id: 'ranger', name: 'Ranger', tag: 'Bow, wilds and patience.', hp: 28, mana: 5, grow: [6, 2], skills: [['Archery', 3], ['Survival', 3], ['Stealth', 1]],
            traits: 'Wilderness hunter and tracker. Deadly at range, at home outdoors, uncomfortable in cities and crowds.' },
        { id: 'bard', name: 'Bard', tag: 'Silver tongue, sharp wit.', hp: 22, mana: 8, grow: [4, 3], skills: [['Persuasion', 3], ['Performance', 2], ['Insight', 1]],
            traits: 'Charming performer and gossip. Talks their way into and out of trouble, picks up rumors everywhere; weak in direct combat. Minor magic through song costs mana.' },
        { id: 'deathknight', name: 'Death Knight', tag: 'Bound to a cold, dark power.', hp: 30, mana: 8, grow: [6, 3], skills: [['Swordsmanship', 2], ['Magic', 2], ['Intimidation', 2]],
            traits: 'Armored and bound to necrotic power. Dark abilities (life-drain, fear aura, unholy strikes) cost mana. Unsettles animals and the living, shunned by the faithful, and is unusually hard to kill.' },
    ];
    const presetDesc = (n) => PRESET_SKILLS.find(([p]) => p === n)?.[1] || '';

    // Standard array (15,14,13,12,10,8) assigned per class, plus a starting kit. `eq` = starts equipped.
    const POTION = { name: 'Healing Potion', type: 'potion', heal: '2d4+2' };
    const CLASS_KIT = {
        warrior: { stats: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, gold: 15, gear: [
            { name: 'Longsword', type: 'weapon', dmg: '1d8', ability: 'str', eq: 1 }, { name: 'Chain Shirt', type: 'armor', ac: 14, eq: 1 },
            { name: 'Shield', type: 'shield', ac: 2, eq: 1 }, { ...POTION, qty: 2 }] },
        rogue: { stats: { str: 8, dex: 15, con: 13, int: 12, wis: 10, cha: 14 }, gold: 20, gear: [
            { name: 'Shortsword', type: 'weapon', dmg: '1d6', ability: 'dex', eq: 1 }, { name: 'Dagger', type: 'weapon', dmg: '1d4', ability: 'dex' },
            { name: 'Leather Armor', type: 'armor', ac: 11, eq: 1 }, { ...POTION, qty: 2 }, { name: "Thieves' Tools", type: 'misc', desc: 'Picks and probes.' }] },
        mage: { stats: { str: 8, dex: 13, con: 14, int: 15, wis: 12, cha: 10 }, gold: 25, gear: [
            { name: 'Quarterstaff', type: 'weapon', dmg: '1d6', ability: 'str', eq: 1 }, { ...POTION, qty: 1 },
            { name: 'Mana Potion', type: 'potion', mana: '1d6+2' }, { name: 'Spellbook', type: 'misc', desc: 'Your spells, in your own hand.' }] },
        cleric: { stats: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 }, gold: 10, gear: [
            { name: 'Mace', type: 'weapon', dmg: '1d6', ability: 'str', eq: 1 }, { name: 'Scale Mail', type: 'armor', ac: 14, eq: 1 },
            { name: 'Shield', type: 'shield', ac: 2, eq: 1 }, { ...POTION, qty: 2 }, { name: 'Holy Symbol', type: 'misc' }] },
        ranger: { stats: { str: 12, dex: 15, con: 13, int: 10, wis: 14, cha: 8 }, gold: 15, gear: [
            { name: 'Shortbow', type: 'weapon', dmg: '1d6', ability: 'dex', eq: 1 }, { name: 'Shortsword', type: 'weapon', dmg: '1d6', ability: 'dex' },
            { name: 'Leather Armor', type: 'armor', ac: 11, eq: 1 }, { ...POTION, qty: 2 }] },
        bard: { stats: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 15 }, gold: 30, gear: [
            { name: 'Rapier', type: 'weapon', dmg: '1d8', ability: 'dex', eq: 1 }, { name: 'Leather Armor', type: 'armor', ac: 11, eq: 1 },
            { ...POTION, qty: 1 }, { name: 'Lute', type: 'misc', desc: 'Well worn, well loved.' }] },
        deathknight: { stats: { str: 15, dex: 8, con: 14, int: 13, wis: 12, cha: 10 }, gold: 5, gear: [
            { name: 'Greatsword', type: 'weapon', dmg: '2d6', ability: 'str', eq: 1 }, { name: 'Plate Armor', type: 'armor', ac: 16, eq: 1 }, { ...POTION, qty: 1 }] },
    };

    // ───────────────────────── genres ─────────────────────────
    // A genre bundles classes + starting kits + skill list + wording. Adding another (sci-fi, western, …) is just more data here.
    const MODERN_SKILLS = [
        ['Firearms', 'Pistols, rifles and keeping your aim under pressure.'], ['Brawling', 'Fists, improvised weapons and street fighting.'],
        ['Athletics', 'Running, climbing, swimming and endurance.'], ['Stealth', 'Moving unseen, tailing people, picking pockets.'],
        ['Driving', 'Cars, bikes and getaways.'], ['Hacking', 'Computers, networks and electronics.'],
        ['Investigation', 'Clues, records and putting the picture together.'], ['Medicine', 'First aid, trauma care and diagnosis.'],
        ['Mechanics', 'Fixing and sabotaging machines and vehicles.'], ['Streetwise', 'The underworld, the city and who to ask.'],
        ['Persuasion', 'Convincing, negotiating, charm.'], ['Deception', 'Lying, bluffing, disguises and forgery.'],
        ['Intimidation', 'Threats, presence, breaking morale.'], ['Insight', 'Reading intent, spotting lies and moods.'],
        ['Survival', 'Wilderness, field medicine, navigation.'],
    ];
    const MODERN_CLASSES = [
        { id: 'soldier', name: 'Soldier', tag: 'Trained for the worst day.', hp: 34, mana: 2, grow: [7, 1], skills: [['Firearms', 3], ['Brawling', 2], ['Survival', 1]],
            traits: 'Military-trained. Reliable under fire, fit and disciplined; comfortable with weapons and tactics, less at home with polite society or technology.' },
        { id: 'detective', name: 'Detective', tag: 'Sees what others miss.', hp: 24, mana: 6, grow: [5, 2], skills: [['Investigation', 3], ['Insight', 2], ['Firearms', 1]],
            traits: 'Methodical investigator. Notices clues, reads people and builds a case; has contacts in law enforcement. Average in a straight fight.' },
        { id: 'hacker', name: 'Hacker', tag: 'The network is the weapon.', hp: 18, mana: 14, grow: [3, 4], skills: [['Hacking', 3], ['Mechanics', 2], ['Stealth', 1]],
            traits: 'Elite with computers, networks and electronics. Digital intrusions and gadgets spend Focus (report as negative mana). Physically frail and happiest behind a screen.' },
        { id: 'medic', name: 'Medic', tag: 'Keeps people alive.', hp: 26, mana: 8, grow: [5, 3], skills: [['Medicine', 3], ['Insight', 1], ['Persuasion', 1], ['Athletics', 1]],
            traits: 'Trauma-trained. Stabilises wounds, treats illness and stays calm in a crisis; strangers trust them in an emergency. Prefers not to fight.' },
        { id: 'fixer', name: 'Fixer', tag: 'Knows a guy.', hp: 22, mana: 8, grow: [4, 3], skills: [['Persuasion', 3], ['Deception', 2], ['Streetwise', 1]],
            traits: 'Social operator with a long contact list. Talks, bargains and bluffs through problems and always knows who to call; weak in a brawl. Has a little extra cash.' },
        { id: 'driver', name: 'Driver', tag: 'Fast hands, faster car.', hp: 28, mana: 5, grow: [6, 2], skills: [['Driving', 3], ['Mechanics', 2], ['Firearms', 1]],
            traits: 'Wheelman and mechanic. Unmatched behind the wheel, quick to fix or hot-wire a vehicle, cool under pressure; cautious about close combat.' },
        { id: 'brawler', name: 'Brawler', tag: 'Hits first, asks later.', hp: 34, mana: 2, grow: [7, 1], skills: [['Brawling', 3], ['Intimidation', 2], ['Streetwise', 1]],
            traits: 'Street fighter or bouncer. Tough, intimidating and happiest in a scrap; weak with technology and paperwork.' },
    ];
    const FIRSTAID = { name: 'First Aid Kit', type: 'consumable', heal: '2d4+2', desc: 'Bandages, antiseptic and a steady hand.' };
    const MODERN_KIT = {
        soldier: { stats: { str: 14, dex: 13, con: 15, int: 8, wis: 12, cha: 10 }, gold: 200, gear: [
            { name: 'Service Pistol', type: 'weapon', dmg: '1d10', ability: 'dex', eq: 1 }, { name: 'Combat Knife', type: 'weapon', dmg: '1d4', ability: 'dex' },
            { name: 'Body Armor', type: 'armor', ac: 14, eq: 1 }, { ...FIRSTAID, qty: 2 }] },
        detective: { stats: { str: 8, dex: 13, con: 10, int: 15, wis: 14, cha: 12 }, gold: 150, gear: [
            { name: 'Revolver', type: 'weapon', dmg: '1d8', ability: 'dex', eq: 1 }, { name: 'Overcoat', type: 'armor', ac: 11, eq: 1 },
            { ...FIRSTAID, qty: 1 }, { name: 'Notebook', type: 'misc', desc: 'Half-filled with case notes.' }, { name: 'Flashlight', type: 'misc' }] },
        hacker: { stats: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, gold: 100, gear: [
            { name: 'Taser', type: 'weapon', dmg: '1d4', ability: 'dex', eq: 1 }, { name: 'Reinforced Hoodie', type: 'armor', ac: 11, eq: 1 },
            { name: 'Laptop', type: 'misc', desc: 'Stickered, scuffed, loaded with tools.' }, { name: 'Energy Drink', type: 'consumable', mana: '1d6+2', qty: 2 }, { ...FIRSTAID, qty: 1 }] },
        medic: { stats: { str: 8, dex: 10, con: 14, int: 13, wis: 15, cha: 12 }, gold: 120, gear: [
            { name: 'Stun Baton', type: 'weapon', dmg: '1d6', ability: 'str', eq: 1 }, { name: 'Light Vest', type: 'armor', ac: 12, eq: 1 },
            { ...FIRSTAID, qty: 3 }, { name: 'Energy Drink', type: 'consumable', mana: '1d6+2', qty: 1 }] },
        fixer: { stats: { str: 8, dex: 14, con: 10, int: 12, wis: 13, cha: 15 }, gold: 500, gear: [
            { name: 'Compact Pistol', type: 'weapon', dmg: '1d8', ability: 'dex', eq: 1 }, { name: 'Tailored Jacket', type: 'armor', ac: 11, eq: 1 },
            { ...FIRSTAID, qty: 1 }, { name: 'Burner Phone', type: 'misc', desc: 'Untraceable, mostly.' }] },
        driver: { stats: { str: 13, dex: 15, con: 14, int: 12, wis: 10, cha: 8 }, gold: 180, gear: [
            { name: 'Tire Iron', type: 'weapon', dmg: '1d6', ability: 'str', eq: 1 }, { name: 'Pistol', type: 'weapon', dmg: '1d8', ability: 'dex' },
            { name: 'Leather Jacket', type: 'armor', ac: 12, eq: 1 }, { ...FIRSTAID, qty: 1 }, { name: 'Toolkit', type: 'misc' }] },
        brawler: { stats: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, gold: 80, gear: [
            { name: 'Baseball Bat', type: 'weapon', dmg: '1d6', ability: 'str', eq: 1 }, { name: 'Brass Knuckles', type: 'weapon', dmg: '1d4', ability: 'str' },
            { name: 'Leather Jacket', type: 'armor', ac: 12, eq: 1 }, { ...FIRSTAID, qty: 2 }] },
    };

    // ── Slice of Life: a social, non-combat genre (no HP / AC / enemies) ──
    const SLICE_SKILLS = [
        ['Charm', 'Being liked: warmth, flirting, making a good first impression.'], ['Persuasion', 'Convincing, negotiating, talking someone round.'],
        ['Deception', 'Lying, bluffing, spinning a story, keeping secrets.'], ['Insight', 'Reading intent, spotting lies and unspoken feelings.'],
        ['Performance', 'Public speaking, music, acting and winning a room.'], ['Leadership', 'Rallying people, organising, getting a group moving.'],
        ['Composure', 'Staying calm and dignified under pressure or embarrassment.'], ['Streetwise', 'Gossip, local knowledge, who knows who.'],
        ['Intimidation', 'Presence, ultimatums, making someone back down.'], ['Academics', 'Studying, research, and knowing your subject.'],
        ['Artistry', 'Creative work: writing, music, design, craft.'], ['Tech Savvy', 'Phones, social media, computers and gadgets.'],
        ['Athletics', 'Sports, fitness and physical stamina.'],
    ];
    const SLICE_CLASSES = [
        { id: 'socialite', name: 'Socialite', tag: 'Everyone knows your name.', hp: 20, mana: 10, grow: [0, 0], skills: [['Charm', 3], ['Persuasion', 2], ['Streetwise', 1]],
            traits: 'Magnetic and well-connected. Walks into any room and gets noticed; knows the gossip and who to impress. Image-conscious, so a scandal or a snub stings.' },
        { id: 'performer', name: 'Performer', tag: 'Born for the spotlight.', hp: 20, mana: 10, grow: [0, 0], skills: [['Performance', 3], ['Charm', 2], ['Artistry', 1]],
            traits: 'Musician, actor or speaker who thrives on an audience. Can win a crowd and sway moods; craves approval and can struggle when no one is watching.' },
        { id: 'counselor', name: 'Counselor', tag: 'The one everyone confides in.', hp: 20, mana: 10, grow: [0, 0], skills: [['Insight', 3], ['Persuasion', 2], ['Composure', 1]],
            traits: 'Calm listener who reads people. Draws out secrets and talks others down; people trust them with things they tell no one else. Slower to push their own wants.' },
        { id: 'overachiever', name: 'Overachiever', tag: 'Top of the class, every time.', hp: 20, mana: 10, grow: [0, 0], skills: [['Academics', 3], ['Leadership', 2], ['Composure', 1]],
            traits: 'Driven, prepared and respected by authority. Great under formal pressure and in charge of a group; can come across as stiff or competitive.' },
        { id: 'rebel', name: 'Rebel', tag: 'Plays by their own rules.', hp: 20, mana: 10, grow: [0, 0], skills: [['Streetwise', 3], ['Deception', 2], ['Intimidation', 1]],
            traits: 'Outsider with an edge. Knows the back routes and the unwritten rules, bluffs well and doesn\'t scare easily; authority and the in-crowd are wary of them.' },
        { id: 'organizer', name: 'Organizer', tag: 'Gets people moving together.', hp: 20, mana: 10, grow: [0, 0], skills: [['Leadership', 3], ['Persuasion', 2], ['Insight', 1]],
            traits: 'Natural coordinator and team-builder. Turns a vague idea into a plan and a crowd into a crew; people follow, but they also hold them responsible.' },
        { id: 'artist', name: 'Artist', tag: 'Sees and says what others can\'t.', hp: 20, mana: 10, grow: [0, 0], skills: [['Artistry', 3], ['Insight', 2], ['Charm', 1]],
            traits: 'Creative and perceptive. Expresses what people feel and notices what they hide; moves hearts through their work. Can be moody and lose track of the practical.' },
    ];
    const SLICE_KIT = {
        socialite: { stats: { str: 8, dex: 13, con: 10, int: 12, wis: 14, cha: 15 }, gold: 400, gear: [
            { name: 'Smartphone', type: 'misc', desc: 'Full of contacts, always buzzing.' }, { name: 'Designer Jacket', type: 'misc' }, { name: 'Party Invitation', type: 'misc', desc: 'The right one.' }] },
        performer: { stats: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 }, gold: 150, gear: [
            { name: 'Smartphone', type: 'misc' }, { name: 'Instrument', type: 'misc', desc: 'Well worn, well loved.' }, { name: 'Stage Outfit', type: 'misc' }] },
        counselor: { stats: { str: 8, dex: 10, con: 12, int: 13, wis: 15, cha: 14 }, gold: 200, gear: [
            { name: 'Smartphone', type: 'misc' }, { name: 'Journal', type: 'misc', desc: 'Half-filled with other people\'s worries.' }, { name: 'Thermos of Tea', type: 'consumable' }] },
        overachiever: { stats: { str: 8, dex: 10, con: 14, int: 15, wis: 12, cha: 13 }, gold: 250, gear: [
            { name: 'Smartphone', type: 'misc' }, { name: 'Planner', type: 'misc', desc: 'Color-coded to the minute.' }, { name: 'Laptop', type: 'misc' }] },
        rebel: { stats: { str: 8, dex: 15, con: 13, int: 10, wis: 12, cha: 14 }, gold: 80, gear: [
            { name: 'Smartphone', type: 'misc', desc: 'Cracked screen.' }, { name: 'Leather Jacket', type: 'misc' }, { name: 'Spare Key', type: 'misc', desc: 'To a place you shouldn\'t have one for.' }] },
        organizer: { stats: { str: 8, dex: 10, con: 13, int: 12, wis: 14, cha: 15 }, gold: 220, gear: [
            { name: 'Smartphone', type: 'misc' }, { name: 'Clipboard', type: 'misc' }, { name: 'Group Chat Admin Rights', type: 'misc', desc: 'A small, real power.' }] },
        artist: { stats: { str: 8, dex: 12, con: 10, int: 13, wis: 14, cha: 15 }, gold: 100, gear: [
            { name: 'Smartphone', type: 'misc' }, { name: 'Sketchbook', type: 'misc', desc: 'Your best work is in here.' }, { name: 'Paint-Stained Hoodie', type: 'misc' }] },
    };

    const GENRES = {
        fantasy: {
            id: 'fantasy', name: 'Fantasy', blurb: 'Swords, spells and ancient ruins.',
            terms: { mana: 'Mana', cash: 'gold', special: 'spell' },
            skills: PRESET_SKILLS, classes: CLASSES, kits: CLASS_KIT,
            prompt: {
                setting: '',
                sceneExample: `"region":"King's Highway","location":"North of Crosshaven Gate","time":"Morning"`,
                classExample: 'Death Knight', npcExample: 'Vex Nightshade', enemyExample: 'Goblin',
                invExample: `{"add":[{"name":"Shortsword","type":"weapon","dmg":"1d6","ability":"dex","qty":1},{"name":"Healing Potion","type":"potion","heal":"2d4+2","qty":1},{"name":"Chain Shirt","type":"armor","ac":13}],"remove":[{"name":"Rope","qty":1}],"gold":15}`,
                itemRules: `(types: weapon with "dmg" dice and "ability" str/dex; armor with base "ac" 11 leather / 13-14 medium / 16+ heavy; shield "ac":2; potion/consumable with "heal"/"mana" dice; misc). Keep gear modest for the player's level. "gold" is a delta.`,
                acGuide: '10 unarmored, 12 light armor, 14 armored, 16+ heavy',
                pressure: 'casting under pressure',
                attackWho: 'a weapon strike or a damaging spell',
                attackSpell: 'for a spell add "spell":true,"dmg":"1d8" and report the mana cost as a negative "mana"',
            },
        },
        modern: {
            id: 'modern', name: 'Modern', blurb: 'The contemporary real world. Guns, cars, phones — no magic.',
            terms: { mana: 'Focus', cash: 'cash', special: 'special ability' },
            skills: MODERN_SKILLS, classes: MODERN_CLASSES, kits: MODERN_KIT,
            prompt: {
                setting: `[Setting] This is the contemporary real world: cities, cars, phones, guns, police, corporations, the internet. There is NO magic, no fantasy creatures and no medieval gear. Money is cash; the tag's "gold" and "mana" fields mean the player's cash and Focus (the nerve, stamina or adrenaline they spend on special abilities like hacking, tactics or a daring stunt). Keep the tone and realism consistent with whatever the story sets up (grounded crime drama, thriller, slice of life…); violence has real consequences.\n\n`,
                sceneExample: `"region":"Eastside","location":"Parking garage, level 3","time":"11:40 PM"`,
                classExample: 'Detective', npcExample: 'Marcus Webb', enemyExample: 'Thug',
                invExample: `{"add":[{"name":"Compact Pistol","type":"weapon","dmg":"1d8","ability":"dex","qty":1},{"name":"First Aid Kit","type":"consumable","heal":"2d4+2","qty":1},{"name":"Light Vest","type":"armor","ac":12}],"remove":[{"name":"Burner Phone","qty":1}],"gold":200}`,
                itemRules: `(types: weapon with "dmg" dice and "ability" — dex for firearms and light weapons, str for heavy melee; armor with base "ac" 11 clothing / 12 jacket or light vest / 14 body armor / 16+ tactical gear; shield "ac":2 for something like a riot shield; consumable with "heal" (first aid, medication) or "mana" (Focus: caffeine, a pep talk) dice; misc for phones, tools, keys). Keep gear plausible and modest for the player's means. "gold" is a cash delta.`,
                acGuide: '10 unarmored civilian, 12 jacket or street fighter, 14 trained and vested, 16+ armored or behind solid cover',
                pressure: 'hacking, driving or improvising under pressure',
                attackWho: 'shooting, a melee strike or a damaging special ability such as an exploit or explosive',
                attackSpell: 'for a special ability add "spell":true,"dmg":"1d8" and report the Focus cost as a negative "mana"',
            },
        },
    };
    GENRES.slice = {
        id: 'slice', name: 'Slice of Life', blurb: 'Friendships, rivalries and secrets. Social stakes — no combat.',
        combat: false, // no HP / AC / enemies / attack rolls anywhere in the UI or prompt
        terms: { mana: 'Energy', cash: 'cash', special: 'move' },
        skills: SLICE_SKILLS, classes: SLICE_CLASSES, kits: SLICE_KIT,
        prompt: {
            setting: `[Setting] This is a contemporary slice-of-life drama: school, work, a neighbourhood, friends, family, rivals, romance, rumours and secrets. There is no magic. The stakes are social and emotional — trust, reputation, belonging, ambition, embarrassment, loyalty — and the story's drama comes from people. Keep it grounded and character-driven; let choices and relationships have lasting consequences. Money is cash (the tag's "gold" field means the player's cash).\n\n`,
            socialExtra: `
In this game social interaction IS the gameplay, so lean on checks more than usual — whenever someone's feelings, trust, reputation or a secret is genuinely at stake (still not for small talk). Vary the skill: Charm to be liked, Persuasion to convince, Insight to read someone, Composure to keep your cool, Deception for lies, Leadership to rally others, Performance to win a room, Intimidation to make someone back down. Always name the NPC with "npc". Failure is social, never physical: an awkward silence, a lost friend, a rumour, a rival's gain. After every meaningful exchange move the relevant relationships — swings of ±5..±20 are normal here, and a betrayal or a heartfelt moment can move more. NPCs have their own goals and memories; remember what the player has said and done.`,
            sceneExample: `"region":"Maple Street","location":"Corner café","time":"Saturday, 4 PM"`,
            classExample: 'Socialite', npcExample: 'Dana Whitfield', enemyExample: 'Rival',
            invExample: `{"add":[{"name":"Concert Tickets","type":"misc","qty":2},{"name":"Iced Coffee","type":"consumable","qty":1}],"remove":[{"name":"Spare Key","qty":1}],"gold":-20}`,
            itemRules: `(types: consumable and misc only — phones, keys, gifts, tickets, notes, clothes, tools of a hobby; there are no weapons or armor in this game). Keep items plausible for the player's means. "gold" is a cash delta.`,
            acGuide: '(not used)', pressure: 'keeping composure or lying under pressure',
            attackWho: '(not used)', attackSpell: '(not used)',
        },
    };
    const genreOf = (s) => GENRES[s?.genre] || GENRES.fantasy;
    const G = () => genreOf(getState());
    const presetDescAny = (n) => Object.values(GENRES).flatMap((g) => g.skills).find(([p]) => p === n)?.[1] || '';

    let cc = null; // creator wizard state

    function openCreator() {
        const s = getState();
        const genre = GENRES[s.created ? s.genre : settings().defaultGenre] ? (s.created ? s.genre : settings().defaultGenre) : 'fantasy';
        const cur = GENRES[genre].classes.find((c) => c.name === s.class);
        cc = { step: 1, genre, classId: cur?.id || '', name: s.name, avatar: s.avatar || '', backstory: s.backstory || '', bonus: '' };
        if (!document.getElementById('ogt-cc')) document.body.insertAdjacentHTML('beforeend', '<div id="ogt-cc"></div>');
        const el = document.getElementById('ogt-cc');
        el.classList.add('open');
        el.onclick = onCreatorClick;
        el.oninput = (e) => { const k = e.target.dataset.cc; if (k) cc[k] = e.target.value; };
        renderCreator();
    }
    const closeCreator = () => { cc = null; document.getElementById('ogt-cc')?.classList.remove('open'); };

    function renderCreator() {
        const el = document.getElementById('ogt-cc');
        if (!el || !cc) return;
        const gen = GENRES[cc.genre] || GENRES.fantasy;
        const cls = gen.classes.find((c) => c.id === cc.classId);
        let body;
        if (cc.step === 1) {
            body = `<div class="cc-genres">${Object.values(GENRES).map((g) =>
                `<button type="button" class="cc-genre ${g.id === cc.genre ? 'sel' : ''}" data-cc-act="genre" data-id="${g.id}" aria-pressed="${g.id === cc.genre}"><b>${esc(g.name)}</b><span>${esc(g.blurb)}</span></button>`).join('')}</div>
                <div class="cc-grid">${gen.classes.map((c) => `
                <button type="button" class="cc-class ${c.id === cc.classId ? 'sel' : ''}" data-cc-act="pick" data-id="${c.id}" aria-pressed="${c.id === cc.classId}">
                    <span class="cc-cname">${esc(c.name)}</span><span class="cc-tag">${esc(c.tag)}</span>
                    ${gen.combat === false ? '' : `<span class="cc-stats"><b>${c.hp}</b> HP · <b>${c.mana}</b> ${esc(gen.terms.mana)}</span>`}
                    <span class="cc-skills">${ABILITIES.map((a) => `${AB_NAME[a]} ${gen.kits[c.id].stats[a]}`).join(' · ')}</span>
                    <span class="cc-skills">${gen.kits[c.id].gear.filter((g) => gen.combat === false || g.eq).map((g) => esc(g.name)).join(', ')}</span>
                    <span class="cc-skills">${c.skills.map(([n, r]) => `${esc(n)} ${r}`).join(' · ')}</span>
                </button>`).join('')}</div>
                ${cls ? `<div class="cc-traits"><b>${esc(cls.name)}:</b> ${esc(cls.traits)}</div>` : ''}`;
        } else {
            const owned = new Set(cls.skills.map(([n]) => n));
            body = `<div class="ogt-form">
                <label>Name<input data-cc="name" type="text" value="${esc(cc.name)}"></label>
                <label>Portrait URL (optional)<input data-cc="avatar" type="text" value="${esc(cc.avatar)}" placeholder="Leave blank to use your persona image"></label>
                <label>Backstory (shared with the narrator)<textarea data-cc="backstory" rows="4" placeholder="Where you're from, what drives you, what you're running from…">${esc(cc.backstory)}</textarea></label>
            </div>
            <div class="ogt-section">BONUS SKILL (OPTIONAL, RANK 1)</div>
            <div class="ogt-chips">${gen.skills.filter(([n]) => !owned.has(n)).map(([n, d]) =>
                `<button class="ogt-chip ${cc.bonus === n ? 'sel' : ''}" data-cc-act="bonus" data-name="${esc(n)}" title="${esc(d)}">${esc(n)}</button>`).join('')}</div>
            <div class="cc-traits">${esc(gen.name)} · ${esc(cls.name)} · ${gen.combat === false ? '' : `${cls.hp} HP · ${cls.mana} ${esc(gen.terms.mana)} · `}starts with ${cls.skills.map(([n, r]) => `${esc(n)} ${r}`).join(', ')}</div>`;
        }
        const fresh = !getState().created;
        el.innerHTML = `<div class="cc-modal">
            <div class="cc-head"><span class="cc-title">Create your character</span><button class="ogt-btn small" data-cc-act="close">✕</button></div>
            ${fresh ? '' : `<div class="cc-warn">Re-creating resets level, XP, HP/Mana and skills. Quests and relationships are kept.</div>`}
            <div class="cc-steps"><span class="${cc.step === 1 ? 'on' : ''}">1 · Class</span><span class="${cc.step === 2 ? 'on' : ''}">2 · Identity</span></div>
            <div class="cc-body">${body}</div>
            <div class="cc-foot">
                ${cc.step === 2 ? `<button class="ogt-btn" data-cc-act="back">Back</button>` : '<span></span>'}
                ${cc.step === 1 ? `<button class="ogt-btn ogt-spend" data-cc-act="next" ${cls ? '' : 'disabled'}>${cls ? `Continue as ${esc(cls.name)} ›` : 'Tap a class to choose it'}</button>`
                    : `<button class="ogt-btn ogt-spend" data-cc-act="finish">Begin adventure</button>`}
            </div></div>`;
    }

    function finishCreator() {
        const gen = GENRES[cc.genre] || GENRES.fantasy;
        const cls = gen.classes.find((c) => c.id === cc.classId);
        if (!cls) return;
        const kit = gen.kits[cls.id];
        const s = getState();
        Object.assign(s, {
            genre: gen.id,
            name: cc.name.trim() || s.name, class: cls.name, avatar: cc.avatar.trim(), backstory: cc.backstory.trim(),
            traits: cls.traits, growth: { hp: cls.grow[0], mana: cls.grow[1] },
            level: 1, xp: 0, hp: cls.hp, hpMax: cls.hp, mana: cls.mana, manaMax: cls.mana,
            skills: [], skillPoints: 0, created: true,
            stats: { ...(kit?.stats || s.stats) }, statPoints: 0, inv: [], gold: kit?.gold ?? 0, enemies: [],
            luck: 1, luckMax: 3,
        });
        for (const spec of kit?.gear || []) {
            const it = addItem(s, spec);
            if (it && spec.eq) it.equipped = true;
        }
        for (const [n, r] of cls.skills) addSkill(s, n, presetDescAny(n), { base: r });
        if (cc.bonus) addSkill(s, cc.bonus, presetDescAny(cc.bonus), { base: 1 });
        closeCreator();
        persist({ manual: true });
        notify('success', `${s.name} the ${cls.name} is ready.`);
    }

    function onCreatorClick(e) {
        const t = e.target.closest('[data-cc-act]');
        if (e.target.id === 'ogt-cc') return closeCreator();
        if (!t || !cc) return;
        switch (t.dataset.ccAct) {
            case 'close': return closeCreator();
            case 'genre': if (GENRES[t.dataset.id] && cc.genre !== t.dataset.id) { cc.genre = t.dataset.id; cc.classId = ''; cc.bonus = ''; } return renderCreator();
            case 'pick': cc.classId = t.dataset.id; cc.bonus = ''; return renderCreator();
            case 'next': if (cc.classId) { cc.step = 2; renderCreator(); } return;
            case 'back': cc.step = 1; return renderCreator();
            case 'bonus': cc.bonus = cc.bonus === t.dataset.name ? '' : t.dataset.name; return renderCreator();
            case 'finish': return finishCreator();
        }
    }

    function skillHtml(k, pts, max) {
        const pips = Array.from({ length: max }, (_, i) => `<i class="${i < k.rank ? 'on' : ''}"></i>`).join('');
        const cost = rankUpCost(k.rank);
        const canUp = k.rank < max && pts >= cost;
        return `<div class="ogt-skill" data-sid="${esc(k.id)}">
            <div class="ogt-skill-head"><span class="ogt-skill-name">${esc(k.name)}</span>
                <span class="ogt-quest-btns"><button class="ogt-btn small" data-ogt-act="skill-roll" title="Roll ${esc(k.name)} (d20 + ${k.rank})">🎲</button><button class="ogt-btn small" data-ogt-act="skill-up" ${canUp ? '' : 'disabled'} title="Costs ${cost} point${cost > 1 ? 's' : ''}">${k.rank >= max ? 'MAX' : `+ ${cost}`}</button>
                <button class="ogt-btn small" data-ogt-act="skill-del" title="Forget (refunds points)">✕</button></span></div>
            <div class="ogt-pips">${pips}<span class="ogt-xpchip">${esc(RANK_NAMES[k.rank] || '')} · ${fmtMod(skillBonus(getState(), k))}${abilityOf(k) ? ` (${AB_NAME[abilityOf(k)]})` : ''}</span></div>
            ${k.desc ? `<div class="ogt-quest-desc">${esc(k.desc)}</div>` : ''}
        </div>`;
    }

    function renderSkills(s) {
        const max = num(settings().skillMaxRank, 5);
        const pts = s.skillPoints || 0;
        let h = `<div class="ogt-points ${pts ? 'has' : ''}"><span>${pts}</span> skill point${pts === 1 ? '' : 's'} to spend</div>
            <div class="ogt-empty">+${num(settings().pointsPerLevel, 2)} points each level. A new skill costs 1; raising rank r costs r+1.</div>
            <div class="ogt-section">SKILLS</div>`;
        h += s.skills.length ? s.skills.map((k) => skillHtml(k, pts, max)).join('') : `<div class="ogt-empty">No skills yet — learn one below, or let the story teach you.</div>`;
        const have = new Set(s.skills.map((k) => k.id));
        const left = G().skills.filter(([n]) => !have.has(slug(n)));
        if (left.length) {
            h += `<div class="ogt-section">LEARN A SKILL (1 POINT)</div><div class="ogt-chips">${left.map(([n, d]) => `<button class="ogt-chip" data-ogt-act="skill-preset" data-name="${esc(n)}" data-desc="${esc(d)}" ${pts < 1 ? 'disabled' : ''} title="${esc(d)}">${esc(n)}</button>`).join('')}</div>`;
        }
        h += `<div class="ogt-form"><input id="ogt-new-sk" placeholder="Custom skill name"><input id="ogt-new-skd" placeholder="What it covers (optional)">
            <select id="ogt-new-skab"><option value="">No ability bonus</option>${ABILITIES.map((a) => `<option value="${a}">Uses ${AB_NAME[a]}</option>`).join('')}</select>
            <button class="ogt-btn ogt-wide" data-ogt-act="skill-add" ${pts < 1 ? 'disabled' : ''}>Learn custom skill</button>
            ${s.skills.length ? `<button class="ogt-btn ogt-wide danger" data-ogt-act="skill-respec">Respec all skills</button>` : ''}</div>`;
        return h;
    }

    // ── gear tab ──
    function itemBadge(i) {
        if (i.type === 'weapon') return `${i.dmg}${i.bonus ? ` +${i.bonus}` : ''} · ${AB_NAME[i.ability]}`;
        if (i.type === 'armor') return `AC ${i.ac}${i.dexCap == null ? ' + DEX' : i.dexCap === 0 ? '' : ` + DEX (max ${i.dexCap})`}`;
        if (i.type === 'shield') return `+${i.ac} AC`;
        return [i.heal ? `heals ${i.heal}` : '', i.mana ? `${G().terms.mana.toLowerCase()} ${i.mana}` : ''].filter(Boolean).join(' · ');
    }

    /** "Give to…" dropdown for an item: you and every companion except the current holder. */
    function giveSelect(s, fromBag) {
        if (!settings().trackParty || !s.party.length) return '';
        const opts = [fromBag === 'player' ? null : ['player', `${s.name} (you)`], ...s.party.filter((p) => p.id !== fromBag).map((p) => [p.id, p.name])].filter(Boolean);
        return opts.length ? `<select class="ogt-give-sel" data-ogt-give title="Hand this item over"><option value="">Give to…</option>${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>` : '';
    }

    /** One of a companion's carried items (Party tab). */
    function memberItemHtml(s, p, i) {
        const usable = (i.type === 'potion' || i.type === 'consumable') && (i.heal || i.mana);
        const equippable = ['weapon', 'armor', 'shield'].includes(i.type) && hasCombat(s);
        return `<div class="ogt-item ${i.equipped ? 'eq' : ''}" data-bag="${esc(p.id)}" data-miid="${esc(i.id)}" data-mitype="${esc(i.type)}">
            <div class="ogt-item-head"><span class="ogt-item-name">${esc(i.name)}${i.qty > 1 ? ` <i>×${i.qty}</i>` : ''}</span>
                <span class="ogt-quest-btns">
                    ${equippable ? `<button class="ogt-btn small" data-ogt-act="pm-item-equip">${i.equipped ? 'Unequip' : 'Equip'}</button>` : ''}
                    ${usable ? `<button class="ogt-btn small" data-ogt-act="pm-item-use">Use</button>` : ''}
                    ${giveSelect(s, p.id)}
                    <button class="ogt-btn small" data-ogt-act="pm-item-drop" title="Drop one">✕</button></span></div>
            <div class="ogt-item-meta"><span class="ogt-badge d-${i.type === 'weapon' ? 'hard' : i.type === 'potion' ? 'easy' : i.type === 'misc' ? 'trivial' : 'medium'}">${esc(i.type)}</span>
                <span class="ogt-xpchip">${esc(itemBadge(i))}</span></div>
        </div>`;
    }

    function itemHtml(i) {
        const equippable = ['weapon', 'armor', 'shield'].includes(i.type);
        const usable = i.type === 'potion' || i.type === 'consumable';
        return `<div class="ogt-item ${i.equipped ? 'eq' : ''}" data-bag="player" data-iid="${esc(i.id)}" data-itype="${esc(i.type)}">
            <div class="ogt-item-head"><span class="ogt-item-name">${esc(i.name)}${i.qty > 1 ? ` <i>×${i.qty}</i>` : ''}</span>
                <span class="ogt-quest-btns">
                    ${giveSelect(getState(), 'player')}
                    ${equippable ? `<button class="ogt-btn small" data-ogt-act="item-equip">${i.equipped ? 'Unequip' : 'Equip'}</button>` : ''}
                    ${usable ? `<button class="ogt-btn small" data-ogt-act="item-use">Use</button>` : ''}
                    <button class="ogt-btn small" data-ogt-act="item-drop" title="Drop one">✕</button></span></div>
            <div class="ogt-item-meta"><span class="ogt-badge d-${i.type === 'weapon' ? 'hard' : i.type === 'potion' ? 'easy' : i.type === 'misc' ? 'trivial' : 'medium'}">${esc(i.type)}</span>
                <span class="ogt-xpchip">${esc(itemBadge(i))}</span></div>
            ${i.desc ? `<div class="ogt-quest-desc">${esc(i.desc)}</div>` : ''}
        </div>`;
    }

    function renderGear(s) {
        const w = equippedOf(s, 'weapon'), a = equippedOf(s, 'armor'), sh = equippedOf(s, 'shield');
        const dex = amod(s.stats.dex);
        const combat = hasCombat(s);
        let h = `${combat ? `<div class="ogt-points has"><span>${computeAC(s)}</span> Armor Class
            <small>${a ? esc(a.name) : 'no armor'} ${a ? '' : '(10'} + DEX ${fmtMod(a && a.dexCap != null ? Math.min(dex, a.dexCap) : dex)}${sh ? ` + ${esc(sh.name)} ${sh.ac}` : ''}${a ? '' : ')'}</small></div>
            <div class="ogt-acrow">Weapon: <b>${w ? `${esc(w.name)} ${w.dmg}${w.bonus ? ` +${w.bonus}` : ''}` : 'unarmed 1d2'}</b> · Attack <b>${fmtMod(attackProfile(s).bonus)}</b></div>` : ''}
            <label class="ogt-field ogt-inline">${G().terms.cash[0].toUpperCase() + G().terms.cash.slice(1)}<input data-ogt-field="gold" type="number" min="0" value="${s.gold}"></label>`;
        const eq = s.inv.filter((i) => i.equipped), pack = s.inv.filter((i) => !i.equipped);
        if (combat) h += `<div class="ogt-section">EQUIPPED</div>${eq.length ? eq.map(itemHtml).join('') : '<div class="ogt-empty">Nothing equipped.</div>'}`;
        h += `<div class="ogt-section">${combat ? 'PACK' : 'BELONGINGS'}</div>${(combat ? pack : s.inv).length ? (combat ? pack : s.inv).map(itemHtml).join('') : '<div class="ogt-empty">Nothing yet.</div>'}`;
        const types = combat ? ITEM_TYPES : ['consumable', 'misc'];
        h += `<div class="ogt-form"><input id="ogt-new-it" placeholder="Add item name"><select id="ogt-new-ittype">${types.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
            ${combat ? '<input id="ogt-new-itstat" placeholder="Stat: weapon dice (1d8), armor AC (14), potion heal (2d4+2)">' : '<input id="ogt-new-itstat" type="hidden">'}
            <button class="ogt-btn ogt-wide" data-ogt-act="item-add">Add item</button></div>`;
        return h;
    }

    // ── notes: small things that happened in the UI (drank a potion, switched weapon) that the narrator should know next turn ──
    function pushNote(text) {
        const c = ctx();
        const last = c.chat[c.chat.length - 1];
        if (!last) return;
        last.extra = last.extra || {};
        last.extra.ogt_notes = [...(last.extra.ogt_notes || []), { t: text, done: false }];
        scheduleSave();
    }
    function notesBlock() {
        const notes = (ctx().chat || []).flatMap((m) => (m.extra?.ogt_notes || []).filter((n) => !n.done).map((n) => n.t));
        return notes.length ? `

[Game notes — the player did this through the game UI since your last reply; acknowledge it naturally, don't repeat exact numbers]
${notes.map((t) => '- ' + t).join('\n')}` : '';
    }

    function renderTesting(s) {
        const btn = (act, label) => `<button class="ogt-btn" data-ogt-act="${act}">${label}</button>`;
        const combat = hasCombat(getState());
        return `<div class="ogt-section">TESTING</div>
            ${['testInfiniteLuck:Infinite Luck (rerolls and advantage cost nothing)', 'testNoDeliver:Don\'t send roll results to the narrator (no API call)']
                .map((x) => { const [k, label] = x.split(/:(.+)/); return `<label class="ogt-check"><input type="checkbox" data-ogt-setting="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`; }).join('')}
            <label class="ogt-field">Force every d20 to<select data-ogt-setting="testDie">
                ${[['', 'Random (normal)'], ['1', '1 (critical fail)'], ['5', '5'], ['10', '10'], ['15', '15'], ['20', '20 (critical)']].map(([v, l]) => `<option value="${v}" ${String(s.testDie) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <div class="ogt-testgrid">
                ${btn('test-full', 'Full HP / Mana')}${btn('test-luck', 'Max Luck')}${btn('test-xp', '+100 XP')}${btn('test-level', 'Level up')}
                ${btn('test-gold', '+1000 gold')}${btn('test-points', '+5 skill / +2 ability pts')}
                ${combat ? btn('test-enemy', 'Add test enemy') + btn('test-clear-enemies', 'Clear enemies') : ''}
            </div>
            <div class="ogt-empty">Spawn a roll card on the latest message (no AI reply needed):</div>
            <div class="ogt-testgrid">
                ${btn('test-check-skill', 'Skill check')}${btn('test-check-adv', 'Skill (advantage)')}${btn('test-check-dis', 'Skill (disadvantage)')}
                ${combat ? btn('test-check-attack', 'Attack') + btn('test-check-defend', 'Enemy attack') + btn('test-check-ally', 'Enemy hits ally') : ''}
                ${btn('test-check-clear', 'Remove card')}
            </div>`;
    }

    /** Put a test roll card on the newest message so dice, rerolls and advantage can be tried without waiting on the narrator. */
    function testCheck(kind, adv = 0) {
        const state = getState(), c = ctx();
        const msg = c.chat[c.chat.length - 1];
        if (!msg) return window.toastr?.warning('Send a message first.', APP_NAME);
        msg.extra = msg.extra || {};
        if (kind === 'clear') { delete msg.extra.ogt_check; delete msg.extra.ogt_roll; }
        else {
            const base = { mod: 0, adv: adv === 'ally' ? 0 : adv, why: 'test roll' };
            if (kind === 'attack') {
                const foe = state.enemies.find((e) => !e.defeated) || addEnemy(state, { name: 'Training Dummy', hp: 20, ac: 12 });
                msg.extra.ogt_check = { ...base, kind: 'attack', spell: false, target: foe.name, ac: foe.ac, bonus: attackProfile(state, false).bonus };
            } else if (kind === 'defend') {
                msg.extra.ogt_check = { ...base, kind: 'defend', enemy: 'Test Goblin', atk: 3, dmg: '1d6', ac: computeAC(state), target: adv === 'ally' ? state.party[0]?.name : undefined };
            } else {
                const sk = state.skills[0];
                msg.extra.ogt_check = {
                    ...base, kind: 'skill', trained: !!sk, ability: sk ? abilityOf(sk) : null, skill: sk?.name || 'Unskilled',
                    bonus: sk ? skillBonus(state, sk) : 0, rel: 0, dc: 15,
                };
            }
            delete msg.extra.ogt_roll;
        }
        persist({ manual: true });
        decorateRolls();
    }

    function renderGM() {
        const s = settings();
        const chk = (k, label) => `<label class="ogt-check"><input type="checkbox" data-ogt-setting="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`;
        return `<div class="ogt-section">GAME MASTER</div>
            ${chk('enabled', 'Enable tracking')}
            ${chk('inject', 'Inject tracker rules into prompt')}
            ${chk('toasts', 'Show level-up / quest toasts')}
            ${chk('theme', `Modern ${APP_NAME} chat theme`)}
            <label class="ogt-field">XP source<select data-ogt-setting="xpMode">
                <option value="quests" ${s.xpMode === 'quests' ? 'selected' : ''}>Quests only (recommended)</option>
                <option value="mixed" ${s.xpMode === 'mixed' ? 'selected' : ''}>Quests + small bonus XP</option>
                <option value="free" ${s.xpMode === 'free' ? 'selected' : ''}>Model decides (no limits)</option></select></label>
            <label class="ogt-field">XP multiplier<input type="number" step="0.25" min="0" max="10" data-ogt-setting="xpMult" value="${s.xpMult}"></label>
            <label class="ogt-field">Skill points per level<input type="number" min="0" max="10" data-ogt-setting="pointsPerLevel" value="${s.pointsPerLevel}"></label>
            <label class="ogt-field">Max skill rank<input type="number" min="1" max="10" data-ogt-setting="skillMaxRank" value="${s.skillMaxRank}"></label>
            ${chk('modelUnlockSkills', 'Let the story unlock new skills (free, rank 1)')}
            ${chk('trackRel', 'Track NPC relationship scores')}
            ${genreOf(getState()).combat === false ? '' : `<label class="ogt-check"><input type="checkbox" data-ogt-combat ${getState().combatOff ? '' : 'checked'}> Combat system for this chat (HP, armor, enemies, initiative, attacks). Turn off for roleplay-only sessions.</label>`}
            ${chk('trackParty', 'Track party members (Party tab)')}
            ${chk('autoEnemies', 'Auto-play enemy turns (and allies\' if you don\'t control them): the game rolls them and sends one summary to the narrator')}
            ${chk('allyControl', 'Companions\' combat turns are mine by default (action bar). Off: the game plays them with their tactics. Each ally can override this.')}
            ${chk('allyXp', 'Companions earn the same XP I do and level up')}
            <label class="ogt-field">Panel side<select data-ogt-setting="panelSide"><option value="left" ${s.panelSide === 'left' ? 'selected' : ''}>Left</option><option value="right" ${s.panelSide === 'right' ? 'selected' : ''}>Right</option></select></label>
            <div class="ogt-empty">Drag the 🔥 and ☰ buttons anywhere if they cover text.</div>
            <button class="ogt-btn ogt-wide" data-ogt-act="reset-buttons">Reset button positions</button>
            ${meguminDetected() ? `<div class="ogt-empty">Megumin Suite detected. Let it handle prose, memory, NPC dossiers and images; this panel covers the RPG sheet, quests and relationship scores. If you'd rather use only Megumin's NPC tracking, untick "Track NPC relationship scores".</div>` : ''}
            <label class="ogt-field">Default genre for new characters<select data-ogt-setting="defaultGenre">${Object.values(GENRES).map((g) => `<option value="${g.id}" ${s.defaultGenre === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
            <div class="ogt-empty">This chat is set in <b>${esc(G().name)}</b>. To change it, re-open the character creator and pick another genre (it rebuilds your class and gear).</div>
            ${chk('collapseMenu', 'Hide ST\'s top icon row behind a menu button')}
            ${chk('dice', 'Dice rolls: skill checks with roll cards')}
            ${chk('luckRerolls', 'Luck: spend a point to reroll a failed check (click-to-roll mode)')}
            <label class="ogt-field">Roll mode<select data-ogt-setting="rollMode">
                <option value="manual" ${s.rollMode === 'manual' ? 'selected' : ''}>Click to roll (you roll when asked)</option>
                <option value="auto" ${s.rollMode === 'auto' ? 'selected' : ''}>Automatic (game rolls for you)</option></select></label>
            ${chk('showRollMsg', 'Show roll results as a chat message (otherwise hidden — the roll card is enough)')}
            ${chk('autoScan', 'Auto-scan story when a reply has no tracker tag (extra API call)')}
            <div class="ogt-empty">${esc(lastStatus)}</div>
            <label class="ogt-field">Injection depth<input type="number" min="0" max="20" data-ogt-setting="depth" value="${s.depth}"></label>
            <label class="ogt-field">Extra GM rules<textarea data-ogt-setting="extraRules" rows="4" placeholder="e.g. Combat is dangerous. Death Knights regain no HP from resting.">${esc(s.extraRules)}</textarea></label>
            ${chk('testMode', 'Testing tools (for debugging; hidden when off)')}
            ${s.testMode ? renderTesting(s) : ''}
            <button class="ogt-btn ogt-wide" data-ogt-act="scan">Scan story for missed updates</button>
            <button class="ogt-btn ogt-wide danger" data-ogt-act="reset">Reset tracker for this chat</button>
            <div class="ogt-empty">State is saved per chat and snapshotted on every reply, so swipes and deletes roll it back correctly.</div>`;
    }

    function render() {
        const panel = document.getElementById('ogt-panel');
        if (!panel) return;
        const s = settings();
        const open = panelOpen();
        panel.classList.toggle('open', open);
        document.getElementById('ogt-toggle')?.classList.toggle('open', open);
        document.body.classList.toggle('ogt-panel-open', open);
        if (!ctx().chatMetadata) {
            panel.querySelector('.ogt-body').innerHTML = `<div class="ogt-empty">Open a chat to begin.</div>`;
            return;
        }
        const state = getState();
        panel.querySelectorAll('.ogt-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === activeTab));
        // the tab row scrolls sideways on phones — keep the selected tab fully visible
        const tabsEl = panel.querySelector('.ogt-tabs'), activeEl = panel.querySelector('.ogt-tab.active');
        if (tabsEl && activeEl && tabsEl.scrollWidth > tabsEl.clientWidth) {
            const l = activeEl.offsetLeft, r = l + activeEl.offsetWidth;
            if (l < tabsEl.scrollLeft) tabsEl.scrollLeft = l - 6;
            else if (r > tabsEl.scrollLeft + tabsEl.clientWidth) tabsEl.scrollLeft = r - tabsEl.clientWidth + 6;
        }
        const active = document.activeElement;
        if (active && panel.contains(active) && /INPUT|TEXTAREA/.test(active.tagName) && active.type !== 'range' && active.type !== 'checkbox') return; // don't clobber typing
        const body = panel.querySelector('.ogt-body');
        const scroll = body.scrollTop;
        body.innerHTML = activeTab === 'character' ? renderCharacter(state) : activeTab === 'quests' ? renderQuests(state) : activeTab === 'party' && settings().trackParty ? renderParty(state) : activeTab === 'skills' ? renderSkills(state) : activeTab === 'gear' ? renderGear(state) : renderGM();
        body.scrollTop = scroll;
    }

    // ───────────────────────── actions ─────────────────────────

    let scanning = false;
    async function scanStory({ silent = false } = {}) {
        const c = ctx();
        if (scanning) return;
        if (!c.generateQuietPrompt) return window.toastr?.error('generateQuietPrompt not available in this SillyTavern version.');
        scanning = true;
        if (!silent) window.toastr?.info('Scanning recent story…', APP_NAME);
        const quietPrompt = `[OOC] Review the recent story and our tracked state:
${JSON.stringify(getState())}
Reply with ONLY one JSON object (no prose, no code fence) containing the CHANGES missing from the tracker, using this schema (omit unchanged keys): {"hp":delta,"mana":delta,"xp":delta,"scene":{"region":"","location":"","time":""},"rel":{"NPC":{"delta":0,"note":""}},"quests":{"add":[{"id":"","title":"","desc":"","difficulty":"trivial|easy|medium|hard|deadly"}],"update":[{"id":"","progress":"","milestone":false}],"complete":[],"fail":[]}}. Leave out xp — quest rewards are paid automatically. If nothing is missing reply {}.`;
        try {
            let out;
            try { out = await c.generateQuietPrompt({ quietPrompt }); } catch { out = await c.generateQuietPrompt(quietPrompt, false, false); }
            const json = out.match(/\{[\s\S]*\}/)?.[0];
            const notes = applyDelta(getState(), JSON.parse(json));
            // snapshot onto the newest AI reply so swipes/deletes stay consistent
            const last = [...c.chat].reverse().find((m) => !m.is_user && !m.is_system);
            if (last) { last.extra = last.extra || {}; last.extra.ogt_snap = clone(getState()); }
            persist({ manual: true });
            lastStatus = 'Auto-scan applied to last reply.';
            if (settings().toasts) notes.forEach(([t, m]) => notify(t, m));
            if (!silent) window.toastr?.success('Tracker updated.', APP_NAME);
        } catch (e) {
            console.error(`[${MODULE}] scan failed`, e);
            lastStatus = 'Scan failed (see console).';
            if (!silent) window.toastr?.error('Could not parse the scan result.', APP_NAME);
        } finally {
            scanning = false;
            render();
        }
    }

    function onClick(e) {
        const target = e.target.closest('[data-ogt-act], .ogt-tab, #ogt-close');
        if (!target) return;
        if (target.id === 'ogt-close') return setPanelOpen(false);
        if (target.classList.contains('ogt-tab')) { activeTab = target.dataset.tab; return render(); }

        const state = getState();
        const act = target.dataset.ogtAct;
        const root = target.closest('[data-rel],[data-qid],[data-sid],[data-iid],[data-eid],[data-pid]');
        const pm = root?.dataset.pid ? state.party.find((p) => p.id === root.dataset.pid) : null;
        const skill = root?.dataset.sid ? state.skills.find((k) => k.id === root.dataset.sid) : null;
        const item = root?.dataset.iid ? state.inv.find((i) => i.id === root.dataset.iid && i.type === root.dataset.itype) : null;
        const maxRank = num(settings().skillMaxRank, 5);
        const relName = root?.dataset.rel;
        const q = root?.dataset.qid ? state.quests.find((x) => x.id === root.dataset.qid) : null;

        switch (act) {
            case 'toggle-edit': editingChar = !editingChar; return render();
            case 'toggle-rel': expandedRel.has(relName) ? expandedRel.delete(relName) : expandedRel.add(relName); return render();
            case 'del-rel': delete state.rel[relName]; return persist({ manual: true });
            case 'add-rel': {
                const input = document.getElementById('ogt-new-rel');
                const n = safeName(input.value);
                if (n && !Object.hasOwn(state.rel, n)) state.rel[n] = { value: 0, note: '' };
                input.value = '';
                return persist({ manual: true });
            }
            case 'toggle-pm': if (!pm) return; expandedParty.has(pm.id) ? expandedParty.delete(pm.id) : expandedParty.add(pm.id); return render();
            case 'pm-hp': if (!pm) return; pm.hp = clamp(pm.hp + num(target.dataset.d), 0, pm.hpMax); return persist({ manual: true });
            case 'pm-mana': if (!pm) return; pm.mana = clamp(pm.mana + num(target.dataset.d), 0, pm.manaMax); return persist({ manual: true });
            case 'pm-full': if (!pm) return; pm.hp = pm.hpMax; pm.mana = pm.manaMax; return persist({ manual: true });
            case 'pm-del':
                if (pm && confirm(`Remove ${pm.name} from the party?${pm.inv.length ? ' Their gear goes back to your pack.' : ''}`)) {
                    returnGear(state, pm);
                    state.party = state.party.filter((p) => p !== pm); expandedParty.delete(pm.id);
                    return persist({ manual: true });
                }
                return;
            case 'pm-item-use': {
                const row = target.closest('[data-miid]');
                const it = pm?.inv.find((x) => x.id === row?.dataset.miid && x.type === row?.dataset.mitype);
                if (!it) return;
                const parts = [];
                if (it.heal) { const b = pm.hp; pm.hp = Math.min(pm.hpMax, pm.hp + rollDice(parseDice(it.heal)).total); parts.push(`restored ${pm.hp - b} HP`); }
                if (it.mana && pm.manaMax) { const b = pm.mana; pm.mana = Math.min(pm.manaMax, pm.mana + rollDice(parseDice(it.mana)).total); parts.push(`restored ${pm.mana - b} ${G().terms.mana.toLowerCase()}`); }
                it.qty -= 1;
                if (it.qty <= 0) pm.inv.splice(pm.inv.indexOf(it), 1);
                const t = `${pm.name} used ${it.name}${parts.length ? ': ' + parts.join(', ') : ''}.`;
                pushNote(t); notify('success', t);
                return persist({ manual: true });
            }
            case 'pm-item-equip': {
                const row = target.closest('[data-miid]');
                const it = pm?.inv.find((x) => x.id === row?.dataset.miid && x.type === row?.dataset.mitype);
                if (!it) return;
                if (it.equipped) it.equipped = false;
                else { pm.inv.forEach((i) => { if (i.type === it.type) i.equipped = false; }); it.equipped = true; }
                recalcParty(state);
                pushNote(`${pm.name} ${it.equipped ? 'equipped' : 'put away'} ${it.name} (AC is now ${pm.ac}).`);
                return persist({ manual: true });
            }
            case 'pm-item-drop': {
                const row = target.closest('[data-miid]');
                const it = pm?.inv.find((x) => x.id === row?.dataset.miid && x.type === row?.dataset.mitype);
                if (!it) return;
                it.qty -= 1;
                if (it.qty <= 0) pm.inv.splice(pm.inv.indexOf(it), 1);
                pushNote(`${pm.name} discarded ${it.name}.`);
                return persist({ manual: true });
            }
            case 'add-pm': {
                const val = (id) => document.getElementById(id)?.value ?? '';
                const name = val('ogt-pm-name').trim();
                if (!name) return window.toastr?.warning('Give the companion a name.', APP_NAME);
                const p = addMember(state, {
                    name, class: val('ogt-pm-class').trim() || 'Companion', level: val('ogt-pm-level'),
                    hp: val('ogt-pm-hp') || 20, mana: val('ogt-pm-mana') || 0, ac: val('ogt-pm-ac') || 12, skills: parseSkillText(val('ogt-pm-skills')),
                });
                if (!p) return window.toastr?.warning('That name is already in the party (or the party is full).', APP_NAME);
                expandedParty.add(p.id);
                ctx().chatMetadata.ogt_base = clone(state);
                return persist({ manual: true });
            }
            case 'add-quest': {
                const t = document.getElementById('ogt-new-q').value.trim();
                if (!t) return;
                const diff = normDiff(document.getElementById('ogt-new-qdiff').value);
                state.quests.push({ id: `q${Date.now().toString(36)}`, title: t, desc: document.getElementById('ogt-new-qd').value.trim(), progress: '', status: 'active', difficulty: diff, xp: DIFFICULTY[diff], paid: 0, ms: 0, awarded: false });
                document.getElementById('ogt-new-q').value = ''; document.getElementById('ogt-new-qd').value = '';
                return persist({ manual: true });
            }
            case 'q-done': {
                if (!q) return;
                const notes = [];
                completeQuest(state, q, notes);
                persist({ manual: true });
                if (settings().toasts) notes.forEach(([t, m]) => window.toastr?.[t]?.(m, APP_NAME));
                return;
            }
            case 'q-fail': if (q) q.status = 'failed'; return persist({ manual: true });
            case 'q-reopen': if (q) q.status = 'active'; return persist({ manual: true });
            case 'q-del': state.quests = state.quests.filter((x) => x !== q); return persist({ manual: true });
            case 'open-creator': return openCreator();
            case 'goto-skills': activeTab = 'skills'; return render();
            case 'stat-up': {
                const ab = target.dataset.ab;
                if (!ABILITIES.includes(ab) || state.statPoints < 1 || state.stats[ab] >= 20) return;
                state.statPoints -= 1; state.stats[ab] += 1;
                return persist({ manual: true });
            }
            case 'item-equip': {
                if (!item) return;
                if (item.equipped) item.equipped = false;
                else { state.inv.forEach((i) => { if (i.type === item.type) i.equipped = false; }); item.equipped = true; }
                pushNote(`${state.name} ${item.equipped ? 'equipped' : 'put away'} ${item.name} (AC is now ${computeAC(state)}).`);
                return persist({ manual: true });
            }
            case 'item-use': {
                if (!item) return;
                const name = item.name, parts = [];
                if (item.heal) { const before = state.hp; state.hp = Math.min(state.hpMax, state.hp + rollDice(parseDice(item.heal)).total); parts.push(`restored ${state.hp - before} HP`); }
                if (item.mana) { const before = state.mana; state.mana = Math.min(state.manaMax, state.mana + rollDice(parseDice(item.mana)).total); parts.push(`restored ${state.mana - before} ${G().terms.mana.toLowerCase()}`); }
                removeItem(state, name, 1);
                const text = `${state.name} used ${name}${parts.length ? ': ' + parts.join(', ') : ''} ${hasCombat(state) ? ` (HP ${state.hp}/${state.hpMax}, ${G().terms.mana} ${state.mana}/${state.manaMax})` : ''}.`;
                pushNote(text);
                notify('success', text);
                return persist({ manual: true });
            }
            case 'item-drop': if (item) { removeItem(state, item.name, 1); pushNote(`${state.name} discarded ${item.name}.`); } return persist({ manual: true });
            case 'item-add': {
                const name = document.getElementById('ogt-new-it').value.trim();
                if (!name) return;
                const type = document.getElementById('ogt-new-ittype').value;
                const stat = document.getElementById('ogt-new-itstat').value.trim();
                const spec = { name, type };
                if (type === 'weapon') spec.dmg = stat || '1d6';
                else if (type === 'armor' || type === 'shield') spec.ac = num(stat, type === 'shield' ? 2 : 11);
                else if (type === 'potion' || type === 'consumable') { spec.heal = stat; }
                addItem(state, spec);
                document.getElementById('ogt-new-it').value = ''; document.getElementById('ogt-new-itstat').value = '';
                return persist({ manual: true });
            }
            case 'foe-del': state.enemies = state.enemies.filter((e) => e.id !== root?.dataset.eid); return persist({ manual: true });
            case 'foes-clear': state.enemies = []; return persist({ manual: true });
            case 'act-attack': return startAttackAction();
            case 'act-ability': {
                const ab = turnHolder(state)?.ref.abilities?.find((a) => a.id === target.dataset.aid);
                return ab?.kind === 'heal' ? healAction(ab.id) : startAttackAction(ab?.id);
            }
            case 'act-item': return itemAction();
            case 'act-defend': return defendAction();
            case 'act-flee': return fleeAction();
            case 'act-custom': return customAction();
            case 'ab-add': {
                const o = ownerOf(state, target.dataset.owner);
                if (!o) return;
                const val = (k) => document.getElementById(`ogt-ab-${k}-${target.dataset.owner}`)?.value ?? '';
                const a = addAbility(o, { name: val('name'), cost: val('cost') || 1, dmg: val('dmg') || '1d8', kind: val('kind') });
                if (!a) return notify('warning', 'Give it a name (and no more than 6 abilities).');
                return persist({ manual: true });
            }
            case 'ab-del': {
                const o = ownerOf(state, target.dataset.owner);
                if (o) o.abilities = (o.abilities || []).filter((x) => x.id !== target.dataset.aid);
                return persist({ manual: true });
            }
            case 'init-next': nextTurn(state); return persist({ manual: true });
            case 'init-run': return runTurnsNow();
            case 'init-reroll': state.combat = null; return persist({ manual: true }); // syncInitiative rolls everyone again (and starts a fresh log)
            case 'skill-roll': if (skill) quickRoll(skill); return;
            case 'skill-up': {
                if (!skill || skill.rank >= maxRank) return;
                const cost = rankUpCost(skill.rank);
                if (state.skillPoints < cost) return;
                state.skillPoints -= cost; skill.rank += 1;
                return persist({ manual: true });
            }
            case 'skill-del': {
                if (!skill) return;
                state.skillPoints += spentOn(skill);
                state.skills = state.skills.filter((k) => k !== skill);
                return persist({ manual: true });
            }
            case 'skill-preset':
            case 'skill-add': {
                if (state.skillPoints < 1) return;
                const name = act === 'skill-preset' ? target.dataset.name : document.getElementById('ogt-new-sk').value.trim();
                const desc = act === 'skill-preset' ? target.dataset.desc : document.getElementById('ogt-new-skd').value.trim();
                const ability = act === 'skill-add' ? document.getElementById('ogt-new-skab')?.value : null;
                if (!name || !addSkill(state, name, desc, { ability })) return;
                state.skillPoints -= 1;
                return persist({ manual: true });
            }
            case 'skill-respec':
                if (confirm('Refund all spent skill points? Class and story-granted skills keep their free ranks; skills you bought are forgotten.')) {
                    state.skills.forEach((k) => { state.skillPoints += spentOn(k); k.rank = Math.max(1, k.base || 0); });
                    state.skills = state.skills.filter((k) => (k.base || 0) > 0);
                    return persist({ manual: true });
                }
                return;
            case 'scan': return scanStory();
            case 'reset-buttons': resetButtonPositions(); return notify('success', 'Floating buttons are back in their default spots.');
            case 'test-full': state.hp = state.hpMax; state.mana = state.manaMax; return persist({ manual: true });
            case 'test-luck': state.luck = state.luckMax; return persist({ manual: true });
            case 'test-xp': { const n = []; gainXp(state, Math.ceil(100 / Math.max(0.01, num(settings().xpMult, 1))), n); n.forEach(([t, m]) => notify(t, m)); return persist({ manual: true }); }
            case 'test-level': {
                const n = [];
                gainXp(state, Math.ceil((xpNeeded(state.level) - state.xp) / Math.max(0.01, num(settings().xpMult, 1))), n);
                n.forEach(([t, m]) => notify(t, m));
                return persist({ manual: true });
            }
            case 'test-gold': state.gold += 1000; return persist({ manual: true });
            case 'test-points': state.skillPoints = (state.skillPoints || 0) + 5; state.statPoints = (state.statPoints || 0) + 2; return persist({ manual: true });
            case 'test-enemy': addEnemy(state, { name: 'Test Goblin', hp: 20, ac: 12 }); return persist({ manual: true });
            case 'test-clear-enemies': state.enemies = []; return persist({ manual: true });
            case 'test-check-skill': return testCheck('skill');
            case 'test-check-adv': return testCheck('skill', 1);
            case 'test-check-dis': return testCheck('skill', -1);
            case 'test-check-attack': return testCheck('attack');
            case 'test-check-defend': return testCheck('defend');
            case 'test-check-ally': return state.party.length ? testCheck('defend', 'ally') : window.toastr?.warning('Add a party member first.', APP_NAME);
            case 'test-check-clear': return testCheck('clear');
            case 'reset':
                if (confirm('Reset all tracked stats, relationships and quests for this chat?')) {
                    const md = ctx().chatMetadata;
                    md.ogt = defaultState(); md.ogt_base = clone(md.ogt);
                    ctx().chat.forEach((m) => { if (m.extra) delete m.extra.ogt_snap; });
                    persist();
                }
                return;
        }
    }

    function onInput(e) {
        const el = e.target;
        const state = getState();
        if (el.dataset.ogtField) {
            const k = el.dataset.ogtField;
            state[k] = el.type === 'number' ? num(el.value) : el.value;
            if (['hp', 'hpMax', 'mana', 'manaMax'].includes(k)) {
                state.hp = clamp(state.hp, 0, state.hpMax); state.mana = clamp(state.mana, 0, state.manaMax);
            }
            ctx().chatMetadata.ogt_base = clone(state);
            scheduleSave(); refreshPrompt();
        } else if (el.dataset.ogtPstat) {
            const p = state.party.find((x) => x.id === el.closest('[data-pid]')?.dataset.pid);
            if (!p || !ABILITIES.includes(el.dataset.ogtPstat)) return;
            p.stats = p.stats || defaultMemberStats();
            p.stats[el.dataset.ogtPstat] = clamp(Math.round(num(el.value, 10)), 3, 20);
            ctx().chatMetadata.ogt_base = clone(state);
            scheduleSave(); refreshPrompt();
        } else if (el.dataset.ogtPfield) {
            const p = state.party.find((x) => x.id === el.closest('[data-pid]')?.dataset.pid);
            if (!p) return;
            const k = el.dataset.ogtPfield;
            if (!['skills', 'name', 'class', 'note', 'level', 'hp', 'hpMax', 'mana', 'manaMax', 'baseAc', 'control', 'stance', 'focus'].includes(k)) return;
            if (k === 'skills') p.skills = parseSkillText(el.value);
            else if (k === 'control') p.control = ['me', 'auto'].includes(el.value) ? el.value : '';
            else if (k === 'stance') p.stance = ['balanced', 'aggressive', 'defensive', 'support'].includes(el.value) ? el.value : 'balanced';
            else if (k === 'focus') p.focus = String(el.value).slice(0, 40);
            else if (['name', 'class', 'note'].includes(k)) p[k] = el.value.slice(0, k === 'note' ? 120 : 40) || (k === 'name' ? p.name : '');
            else {
                p[k] = Math.round(num(el.value, p[k]));
                p.level = clamp(p.level, 1, 20); p.hpMax = clamp(p.hpMax, 1, 500); p.manaMax = clamp(p.manaMax, 0, 200); p.baseAc = clamp(p.baseAc, 5, 25);
                recalcParty(state);
                p.hp = clamp(p.hp, 0, p.hpMax); p.mana = clamp(p.mana, 0, p.manaMax);
            }
            ctx().chatMetadata.ogt_base = clone(state);
            scheduleSave(); refreshPrompt();
        } else if (el.dataset.ogtStat) {
            state.stats[el.dataset.ogtStat] = clamp(Math.round(num(el.value, 10)), 1, 30);
            ctx().chatMetadata.ogt_base = clone(state);
            scheduleSave(); refreshPrompt();
        } else if (el.dataset.ogtRelRange) {
            state.rel[el.dataset.ogtRelRange].value = num(el.value);
            const foot = el.parentElement.querySelector('.ogt-rel-foot span'); if (foot) foot.textContent = el.value;
        } else if (el.dataset.ogtSetting) {
            const k = el.dataset.ogtSetting;
            settings()[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? num(el.value, 1) : el.value;
            saveSettings(); refreshPrompt(); applyTheme();
        }
    }

    function applyTheme() {
        const s = settings();
        document.body.classList.toggle('ogt-theme', !!(s.enabled && s.theme));
        document.body.classList.toggle('ogt-right', s.panelSide === 'right');
        document.body.classList.toggle('ogt-collapse', !!(s.enabled && s.theme && s.collapseMenu));
        if (!document.body.classList.contains('ogt-collapse')) document.body.classList.remove('ogt-menu-open');
        scheduleDecorate();
    }

    function onChange(e) {
        const el = e.target;
        if (el.dataset.ogtSel) { actSel[el.dataset.ogtSel] = el.value; return; } // action-bar target / item pickers
        if (el.dataset.ogtCombat !== undefined) { // per-chat combat on/off
            const state = getState();
            state.combatOff = !el.checked;
            if (state.combatOff) { state.enemies = []; state.combat = null; state.log = []; } // nothing left over from a fight
            persist({ manual: true });
            return;
        }
        if (el.dataset.ogtGive !== undefined) { // hand an item to someone else
            const to = el.value;
            el.value = '';
            const row = el.closest('[data-bag]');
            if (!to || !row) return;
            const state = getState(), from = row.dataset.bag;
            const id = row.dataset.miid || row.dataset.iid, type = row.dataset.mitype || row.dataset.itype;
            const it = bagOf(state, from)?.find((x) => x.id === id && x.type === type);
            if (!it) return;
            let qty = 1;
            if (it.qty > 1) {
                const a = prompt(`Hand over how many ${it.name}? (1-${it.qty})`, '1');
                if (a === null) return;
                qty = clamp(Math.round(num(a, 1)), 1, it.qty);
            }
            const r = transferItem(state, { id, type, from, to, qty });
            if (!r) return notify('warning', 'They cannot carry that (bag full or stack at 99).');
            pushNote(`${bagName(state, from)} handed ${r.qty > 1 ? r.qty + '× ' : ''}${r.item.name} to ${bagName(state, to)}.`);
            return persist({ manual: true });
        }
        if (el.dataset.ogtSetting) { render(); return; }
        if (el.dataset.ogtRelRange || el.dataset.ogtField || el.dataset.ogtStat || el.dataset.ogtPfield || el.dataset.ogtPstat) persist({ manual: true });
    }

    // ───────────────────────── movable floating buttons ─────────────────────────
    // Drag either floating button anywhere if it covers text. The spot is remembered per device (phone vs desktop) as a
    // fraction of the screen, so rotating or resizing keeps it on-screen. GM tab → "Reset button positions" undoes it.
    const FLOAT_BTNS = ['ogt-toggle', 'ogt-menu-btn'];
    const posKey = (id) => `ogt_pos_${id}_${isMobile() ? 'm' : 'd'}`;
    const readPos = (id) => {
        try {
            const p = JSON.parse(localStorage.getItem(posKey(id)) || 'null');
            return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
        } catch (e) { return null; /* storage blocked */ }
    };

    function placeButton(el, left, top) {
        const w = el.offsetWidth || 44, h = el.offsetHeight || 44;
        left = clamp(left, 4, Math.max(4, window.innerWidth - w - 4));
        top = clamp(top, 4, Math.max(4, window.innerHeight - h - 4));
        Object.assign(el.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', transform: 'none' });
        return { left, top };
    }
    function applyButtonPos(el) {
        const p = readPos(el.id);
        if (!p) { for (const k of ['left', 'top', 'right', 'bottom', 'transform']) el.style[k] = ''; return; }
        placeButton(el, p.x * window.innerWidth, p.y * window.innerHeight);
    }
    const applyAllButtonPos = () => FLOAT_BTNS.forEach((id) => { const el = document.getElementById(id); if (el) applyButtonPos(el); });

    function makeDraggable(el) {
        let start = null, moved = false, last = null;
        el.style.touchAction = 'none'; // so a drag moves the button instead of scrolling the page
        el.addEventListener('pointerdown', (e) => {
            if (e.button > 0) return;
            const r = el.getBoundingClientRect();
            start = { px: e.clientX, py: e.clientY, left: r.left, top: r.top };
            moved = false;
            try { el.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
        });
        el.addEventListener('pointermove', (e) => {
            if (!start) return;
            const dx = e.clientX - start.px, dy = e.clientY - start.py;
            if (!moved && Math.hypot(dx, dy) < 8) return; // small wobble is still a tap
            moved = true;
            el.classList.add('ogt-dragging');
            last = placeButton(el, start.left + dx, start.top + dy);
        });
        const end = (e) => {
            if (!start) return;
            try { el.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
            if (moved && last) {
                try { localStorage.setItem(posKey(el.id), JSON.stringify({ x: last.left / window.innerWidth, y: last.top / window.innerHeight })); } catch (err) { /* storage blocked */ }
                el.dataset.dragged = '1';
                setTimeout(() => { delete el.dataset.dragged; }, 80);
            }
            start = null; moved = false; last = null;
            el.classList.remove('ogt-dragging');
        };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
        // the click that follows a drag must not toggle the panel / menu (registered first, so it runs before their handlers)
        el.addEventListener('click', (e) => { if (el.dataset.dragged) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
        el.title = `${el.title} — drag to move`;
    }

    function resetButtonPositions() {
        for (const id of FLOAT_BTNS) { try { localStorage.removeItem(posKey(id)); } catch (e) { /* storage blocked */ } }
        applyAllButtonPos();
    }

    // ───────────────────────── boot ─────────────────────────

    function buildUI() {
        if (document.getElementById('ogt-panel')) return;
        document.body.insertAdjacentHTML('beforeend', `
            <button id="ogt-toggle" title="${APP_NAME}" aria-label="Open the character panel">🔥</button>
            <button id="ogt-menu-btn" title="Menu"><i class="fa-solid fa-bars"></i></button>
            <aside id="ogt-panel">
                <div class="ogt-head">
                    <div class="ogt-tabs">
                        <button class="ogt-tab" data-tab="character">Character</button>
                        <button class="ogt-tab" data-tab="quests">Quests</button>
                        <button class="ogt-tab" data-tab="party">Party</button>
                        <button class="ogt-tab" data-tab="skills">Skills</button>
                        <button class="ogt-tab" data-tab="gear">Gear</button>
                        <button class="ogt-tab" data-tab="gm">GM</button>
                    </div>
                    <button id="ogt-close" title="Hide">‹</button>
                </div>
                <div class="ogt-body"></div>
            </aside>`);
        const panel = document.getElementById('ogt-panel');
        panel.addEventListener('click', onClick);
        panel.addEventListener('input', onInput);
        panel.addEventListener('change', onChange);
        document.addEventListener('click', (e) => {
            const b = e.target.closest('.ogt-check-btn');
            if (b) return doCheckRoll(b);
            const rr = e.target.closest('.ogt-reroll-btn');
            if (rr) return doReroll(rr);
            const av = e.target.closest('.ogt-adv-btn');
            if (av) return doAdvantage(av);
            const ac = e.target.closest('.ogt-accept-btn');
            if (ac) doAccept(ac);
        });
        // choosing a different target on a pending attack card
        document.addEventListener('change', (e) => {
            const who = e.target.closest?.('.ogt-roller-sel, .ogt-assist-sel');
            if (who) { // who takes / helps with a skill check
                const chk = locateCheck(who, false);
                if (!chk) return;
                if (who.classList.contains('ogt-roller-sel')) { chk.by = who.value === 'player' ? undefined : who.value; if (chk.assist === chk.by) chk.assist = undefined; }
                else chk.assist = who.value || undefined;
                scheduleSave(); decorateRolls();
                return;
            }
            const sel = e.target.closest?.('.ogt-target-sel');
            if (!sel) return;
            const chk = locateCheck(sel, false);
            const foe = getState().enemies.find((x) => x.id === sel.value && !x.defeated);
            if (!chk || !foe) return;
            chk.target = foe.name; chk.ac = foe.ac;
            scheduleSave(); decorateRolls();
        });
        FLOAT_BTNS.forEach((id) => makeDraggable(document.getElementById(id)));
        applyAllButtonPos();
        window.addEventListener('resize', applyAllButtonPos);
        // top icon row lives behind a button (CSS does the hiding; this just toggles the class)
        const drawerOpen = () => !!document.querySelector('#top-settings-holder .drawer-content.openDrawer');
        document.getElementById('ogt-menu-btn').addEventListener('click', () => document.body.classList.toggle('ogt-menu-open'));
        document.addEventListener('click', (e) => {
            if (!document.body.classList.contains('ogt-menu-open')) return;
            if (e.target.closest('#top-settings-holder, #ogt-menu-btn, .popup, #toast-container')) return;
            if (!drawerOpen()) document.body.classList.remove('ogt-menu-open');
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawerOpen()) document.body.classList.remove('ogt-menu-open'); });
        document.getElementById('ogt-toggle').addEventListener('click', () => setPanelOpen(!panelOpen()));
        // crossing the phone/desktop breakpoint (rotate, resize) switches to that mode's remembered panel state
        window.matchMedia('(max-width: 800px)').addEventListener?.('change', () => { applyAllButtonPos(); render(); });
    }

    /** A second, always-reachable way to open the panel: an entry in SillyTavern's own ✨ extensions menu (next to the message box). */
    function addMenuEntry(tries = 0) {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) { if (tries < 20) setTimeout(() => addMenuEntry(tries + 1), 500); return; }
        if (document.getElementById('ogt-menu-entry')) return;
        const item = document.createElement('div');
        item.id = 'ogt-menu-entry';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = `<div class="fa-solid fa-dice-d20 extensionsMenuExtensionButton"></div><span>${APP_NAME}</span>`;
        item.addEventListener('click', () => setPanelOpen(!panelOpen()));
        menu.appendChild(item);
    }

    /** Load web fonts without ever blocking page styling (a failed/slow request just leaves the system fallback). */
    function loadFonts() {
        if (document.getElementById('ogt-fonts')) return;
        const l = document.createElement('link');
        l.id = 'ogt-fonts'; l.rel = 'stylesheet'; l.media = 'print'; // media=print = loads without blocking render
        l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Pirata+One&display=swap';
        l.onload = () => { l.media = 'all'; };
        l.onerror = () => l.remove();
        document.head.appendChild(l);
    }

    function init() {
        settings();
        loadFonts();
        buildUI();
        addMenuEntry();
        applyTheme();
        const { eventSource, eventTypes } = ctx();
        eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(eventTypes.CHAT_CHANGED, () => { editingChar = false; expandedRel.clear(); syncFromChat(); });
        eventSource.on(eventTypes.MESSAGE_DELETED, () => syncFromChat());
        eventSource.on(eventTypes.MESSAGE_SWIPED, () => syncFromChat(true));
        eventSource.on(eventTypes.GENERATION_STARTED, (type, _p, dry) => {
            if (dry) return;
            if (type === 'swipe' || type === 'regenerate') syncFromChat(true);
            // fresh dice for every real reply (not for quiet scans, impersonation or continues)
            if (settings().dice && settings().rollMode === 'auto' && [undefined, '', 'normal', 'regenerate', 'swipe'].includes(type)) {
                pendingRoll = { a: d20(), b: d20() };
            }
            refreshPrompt();
        });
        eventSource.on(eventTypes.CHAT_CHANGED, scheduleDecorate);
        eventSource.on(eventTypes.MESSAGE_SWIPED, scheduleDecorate);
        const chatEl = document.getElementById('chat');
        if (chatEl) new MutationObserver(scheduleDecorate).observe(chatEl, { childList: true, subtree: true });
        syncFromChat();
        console.log(`[${MODULE}] loaded`);
    }

    const c0 = ctx();
    c0.eventSource.on(c0.eventTypes.APP_READY, init);
    if (document.getElementById('send_textarea')) init(); // already ready (late load)
})();
