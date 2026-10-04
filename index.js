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
    const TAG_RE = /<!--\s*OGT:?([\s\S]*?)-->|<ogt>([\s\S]*?)<\/ogt>|\[\[OGT:?([\s\S]*?)\]\]/gi;
    let lastStatus = 'No reply seen yet.';
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
            inv: [], gold: 0, enemies: [],
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
        s.enemies.push(en);
        return en;
    }

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

        if (d.class) s.class = String(d.class);
        if (d.hp) s.hp = clamp(s.hp + num(d.hp), 0, s.hpMax);
        if (d.mana) s.mana = clamp(s.mana + num(d.mana), 0, s.manaMax);

        if (d.xp) {
            const mode = settings().xpMode;
            if (mode === 'free') gainXp(s, num(d.xp), notes);
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
            for (const k of ['region', 'location', 'time']) if (d.scene[k]) s.scene[k] = String(d.scene[k]);
        }

        if (d.rel && typeof d.rel === 'object') {
            for (const [name, v] of Object.entries(d.rel)) {
                const r = s.rel[name] || { value: 0, note: '' };
                const before = tierOf(r.value);
                if (typeof v === 'number') r.value += v;
                else if (v && typeof v === 'object') {
                    if (v.set !== undefined) r.value = num(v.set);
                    if (v.delta) r.value += num(v.delta);
                    if (v.note) r.note = String(v.note);
                }
                r.value = clamp(Math.round(r.value), -100, 100);
                s.rel[name] = r;
                const after = tierOf(r.value);
                if (after !== before) notes.push(['info', `${name}: ${before} → ${after}`]);
            }
        }

        const q = d.quests;
        if (q && typeof q === 'object') {
            const find = (ref) => s.quests.find((x) => x.id === ref || x.title.toLowerCase() === String(ref).toLowerCase());
            for (const a of q.add || []) {
                if (!a?.title || find(a.id || a.title)) continue;
                s.quests.push({
                    id: a.id || `q${Date.now().toString(36)}${s.quests.length}`,
                    title: String(a.title), desc: String(a.desc || ''), progress: '', status: 'active',
                    difficulty: normDiff(a.difficulty), xp: DIFFICULTY[normDiff(a.difficulty)], paid: 0, ms: 0, awarded: false,
                });
                notes.push(['info', `New quest: ${a.title}`]);
            }
            for (const u of q.update || []) {
                const t = find(u?.id || u?.title);
                if (!t) continue;
                if (u.progress) t.progress = String(u.progress);
                if (u.desc) t.desc = String(u.desc);
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
        return notes;
    }

    // Models sometimes write the payload as a visible line instead of inside the hidden comment, e.g.
    //   OGT:{"hp":-2}      check:{"skill":"Magic","dc":15}      "roll":{...}
    // Catch those too so nothing leaks into the story and the request still works.
    const BARE_RE = /^[ \t>*_`-]*(?:OGT\s*:\s*(\{.*\})|"?(check|roll)"?\s*:\s*(\{.*\}))[ \t,`*_]*$/gim;
    const hasTags = (text) => new RegExp(TAG_RE.source, 'i').test(text) || new RegExp(BARE_RE.source, 'im').test(text);
    const stripTags = (text) => text.replace(TAG_RE, '').replace(BARE_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();

    function parseTags(text) {
        const deltas = [];
        let m;
        TAG_RE.lastIndex = 0;
        while ((m = TAG_RE.exec(text))) {
            const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/^```(?:json)?|```$/g, '').trim();
            try { deltas.push(JSON.parse(raw)); } catch (e) { console.warn(`[${MODULE}] bad OGT json`, raw); }
        }
        BARE_RE.lastIndex = 0;
        while ((m = BARE_RE.exec(text))) {
            try {
                if (m[1]) deltas.push(JSON.parse(m[1]));
                else deltas.push({ [m[2].toLowerCase()]: JSON.parse(m[3]) });
            } catch (e) { console.warn(`[${MODULE}] bad bare OGT json`, m[0]); }
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
        if (s.toasts) notes.forEach(([type, text]) => window.toastr?.[type]?.(text, APP_NAME));
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
            gear: combat ? {
                weapon: (() => { const w = equippedOf(s, 'weapon'); return w ? `${w.name} (${w.dmg}${w.bonus ? ` +${w.bonus}` : ''}, ${AB_NAME[w.ability]})` : 'unarmed'; })(),
                armor: equippedOf(s, 'armor')?.name || 'none', shield: equippedOf(s, 'shield')?.name || 'none',
                pack: Object.fromEntries(s.inv.filter((i) => !i.equipped).slice(0, 25).map((i) => [i.name, i.qty])), gold: s.gold,
            } : { belongings: Object.fromEntries(s.inv.slice(0, 25).map((i) => [i.name, i.qty])), [genreOf(s).terms.cash]: s.gold },
            enemies: combat ? s.enemies.filter((e) => !e.defeated).map((e) => ({ name: e.name, hp: `${e.hp}/${e.hpMax}`, ac: e.ac })) : undefined,
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
${combat ? ` "enemies":{"add":[{"name":"${G().prompt.enemyExample}","hp":9,"ac":13}],"clear":true},\n` : ''} "quests":{"add":[{"id":"short_id","title":"Quest title","desc":"one line objective","difficulty":"trivial|easy|medium|hard|deadly"}],
           "update":[{"id":"short_id","progress":"what's done / what's next","milestone":true}],
           "complete":["short_id"],"fail":["short_id"]}}
Rules: ${combat ? `hp${settings().xpMode === 'quests' ? '/mana are' : '/mana/xp are'} DELTAS (hp negative for damage, positive for healing).` : (settings().xpMode === 'quests' ? '' : 'xp is a DELTA.')} ${settings().xpMode === 'quests'
    ? 'Do NOT award xp yourself — the game pays XP automatically when a quest is completed. When a quest begins, pick its "difficulty" honestly relative to the player\'s level (trivial: errand; easy: minor risk; medium: real danger or effort; hard: serious threat; deadly: likely lethal). Add "milestone":true to a quest update only when a major objective step is genuinely finished (max 3 per quest). Put a quest id in "complete" only when its goal is fully achieved.'
    : 'Award xp (roughly 3–10) only for meaningful achievements; quest completion is paid automatically from the quest\'s difficulty.'}${settings().trackRel ? " Relationship delta is usually -15..+15 on a -100..100 scale; use it whenever an NPC's feelings toward the player change, and add new NPCs the first time they matter." : ''}${settings().modelUnlockSkills ? ' Use "skills.unlock" only when the player actually learns a brand-new skill through in-story training or discovery (at most one per turn; never for skills they already have).' : ''} Always keep "scene" current when location or time of day changes. Valid JSON only, on a single line.${extra ? '\n' + extra : ''}${diceBlock(s)}${resultBlock()}${notesBlock()}`;
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
    const hasCombat = (s) => genreOf(s).combat !== false;

    function renderCharacter(s) {
        const av = avatarUrl(s);
        const combat = hasCombat(s);
        const field = (k, label, type = 'number') =>
            `<label>${label}<input data-ogt-field="${k}" type="${type}" value="${esc(s[k])}"></label>`;
        let h = `<div class="ogt-card">
            <div class="ogt-portrait" style="${av ? `background-image:url('${esc(av)}')` : ''}">${av ? '' : `<span>${esc(s.name[0] || '?')}</span>`}</div>
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

        // no-combat genres: the people in your life come first, right under your stats
        if (!combat && settings().trackRel) h += relationshipsHtml(s);

        const foes = s.enemies.filter((e) => !e.defeated);
        if (combat && s.enemies.length) {
            h += `<div class="ogt-section">COMBAT</div>${s.enemies.map((e) => `<div class="ogt-foe ${e.defeated ? 'dead' : ''}" data-eid="${esc(e.id)}">
                <div class="ogt-foe-head"><span>${esc(e.name)}</span><span>AC ${e.ac}</span></div>
                <div class="ogt-bar"><div class="ogt-fill hp" style="width:${clamp((e.hp / e.hpMax) * 100, 0, 100)}%"></div></div>
                <div class="ogt-foe-foot"><span>${e.defeated ? 'Defeated' : `${e.hp}/${e.hpMax} HP`}</span><button class="ogt-btn small" data-ogt-act="foe-del" title="Remove">✕</button></div></div>`).join('')}
                ${foes.length ? '' : '<div class="ogt-empty">All enemies defeated.</div>'}
                <button class="ogt-btn ogt-wide" data-ogt-act="foes-clear">End combat</button>`;
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
    const d20 = () => { const b = new Uint32Array(1); crypto.getRandomValues(b); return (b[0] % 20) + 1; };
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
        const bonus = sk ? skillBonus(s, sk) : (ab ? amod(s.stats?.[ab]) : 0);
        const rel = socialBonus(s, r.npc);
        const total = nat + bonus + mod + rel;
        const outcome = nat === 20 ? 'crit' : nat === 1 ? 'critfail'
            : total >= dc ? (total >= dc + 5 ? 'strong' : 'success') : (total <= dc - 5 ? 'badfail' : 'fail');
        return {
            skill: sk?.name || (ab ? `${AB_FULL[ab]}` : String(r.skill || 'Unskilled').slice(0, 30)), trained: !!sk, ability: sk ? abilityOf(sk) : ab,
            npc: r.npc ? String(r.npc).slice(0, 30) : undefined, rel,
            bonus, mod, adv, dice: [dice.a, dice.b], nat, total, dc, outcome, why: String(r.why || '').slice(0, 80),
        };
    }

    const pickNat = (dice, adv) => (adv > 0 ? Math.max(dice.a, dice.b) : adv < 0 ? Math.min(dice.a, dice.b) : dice.a);

    /** Player attack: d20 + proficiency + ability + weapon bonus vs the target's AC; on a hit roll weapon damage and hurt the tracked enemy. */
    function resolveAttack(chk, dice, s) {
        const spell = !!chk.spell;
        const { w, ability, magic, bonus } = attackProfile(s, spell);
        const adv = Math.sign(num(chk.adv, 0)), mod = clamp(Math.round(num(chk.mod, 0)), -5, 5);
        const nat = pickNat(dice, adv), total = nat + bonus + mod;
        const ac = clamp(Math.round(num(chk.ac, 12)), 5, 25);
        const crit = nat === 20, hit = crit || (nat !== 1 && total >= ac);
        const dmgDice = spell ? (parseDice(chk.dmg, s.level) || parseDice('1d8')) : (parseDice(w?.dmg) || parseDice('1d2'));
        let dmg = 0;
        if (hit) dmg = Math.max(1, rollDice(dmgDice, { crit, extra: spell ? 0 : amod(s.stats?.[ability]) + magic }).total);
        const foe = findEnemy(s, chk.target);
        if (hit && foe) { foe.hp = Math.max(0, foe.hp - dmg); if (foe.hp === 0) foe.defeated = true; }
        const label = crit ? 'Critical Hit' : hit ? 'Hit' : nat === 1 ? 'Critical Miss' : 'Miss';
        const how = spell ? genreOf(s).terms.special : (w ? w.name : 'unarmed');
        const foeTxt = foe ? ` ${foe.name}: ${foe.hp}/${foe.hpMax} HP${foe.defeated ? ' — DEFEATED' : ''}.` : '';
        const adTxt = adv ? ` (${adv > 0 ? 'advantage' : 'disadvantage'})` : '';
        return {
            kind: 'attack', nat, total, dice: [dice.a, dice.b], adv, outcome: crit ? 'crit' : hit ? 'success' : nat === 1 ? 'critfail' : 'fail',
            title: `Attack · ${chk.target || 'target'}`, why: String(chk.why || '').slice(0, 80), label,
            line: `d20 ${nat} ${fmtMod(bonus + mod)} = ${total} vs AC ${ac}${hit ? ` · ${dmg} damage` : ''}${foe ? ` · ${foe.name} ${foe.hp}/${foe.hpMax}${foe.defeated ? ' ☠' : ''}` : ''}`,
            text: `Attack on ${chk.target || 'the target'} with ${how}: d20 ${nat}${adTxt} ${fmtMod(bonus + mod)} = ${total} vs AC ${ac} — ${label.toUpperCase()}${hit ? `, ${dmg} damage dealt (already applied by the game)` : ''}.${foeTxt}`,
        };
    }

    /** Enemy attack on the player: d20 + enemy attack bonus vs the player's AC; damage is applied to player HP by the game. */
    function resolveDefend(chk, dice, s) {
        const ac = computeAC(s);
        const atk = clamp(Math.round(num(chk.atk, 3)), 0, 4 + s.level);
        const adv = Math.sign(num(chk.adv, 0)), mod = clamp(Math.round(num(chk.mod, 0)), -5, 5);
        const nat = pickNat(dice, adv), total = nat + atk + mod;
        const crit = nat === 20, hit = crit || (nat !== 1 && total >= ac);
        const dd = parseDice(chk.dmg, s.level) || parseDice('1d6');
        let dmg = 0;
        if (hit) { dmg = Math.max(1, rollDice(dd, { crit }).total); s.hp = Math.max(0, s.hp - dmg); }
        const who = chk.enemy || 'The enemy';
        const label = crit ? 'Critical Hit' : hit ? 'Hit' : 'Miss';
        const down = s.hp === 0 ? ` ${s.name} is at 0 HP and falls unconscious/dying.` : '';
        return {
            kind: 'defend', nat, total, dice: [dice.a, dice.b], adv, outcome: crit ? 'critfail' : hit ? 'fail' : 'success',
            title: `${who} attacks you`, why: String(chk.why || '').slice(0, 80), label,
            line: `d20 ${nat} ${fmtMod(atk + mod)} = ${total} vs your AC ${ac}${hit ? ` · you take ${dmg}` : ''} · HP ${s.hp}/${s.hpMax}`,
            text: `${who} attacks ${s.name}: d20 ${nat} ${fmtMod(atk + mod)} = ${total} vs AC ${ac} — ${label.toUpperCase()}${hit ? `, ${dmg} damage taken (already applied by the game; HP ${s.hp}/${s.hpMax})` : ''}.${down}`,
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
- Register each enemy the moment it appears, with sensible stats: <!--OGT:{"enemies":{"add":[{"name":"${G().prompt.enemyExample}","hp":9,"ac":13}]}}-->. Typical AC: ${G().prompt.acGuide}. Use "enemies":{"clear":true} when the fight ends.
- When the PLAYER attacks (${G().prompt.attackWho}), stop and request: "check":{"kind":"attack","target":"${G().prompt.enemyExample}","ac":13,"why":"the attack, in a few words"} (${G().prompt.attackSpell}). The game rolls the hit and damage with their real weapon and applies it to that enemy.
- When an ENEMY attacks the player, stop and request: "check":{"kind":"defend","enemy":"${G().prompt.enemyExample}","atk":4,"dmg":"1d6+1","why":"how it strikes"} (atk +2..+8, dmg by threat). The game rolls against the player's AC and applies the damage to their HP itself — NEVER also report "hp" for combat damage.
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
        const reTxt = r.rerolled != null ? ` · 🍀 rerolled (was ${r.rerolled})` : '';
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
        if (r.rel) parts.push(`${sign(r.rel)} ${r.npc ? r.npc + "'s" : 'their'} attitude`);
        if (r.mod) parts.push(`${sign(r.mod)} situation`);
        return `<div class="ogt-roll ogt-card out-${r.outcome}" data-kind="${kind}" data-sig="${esc(sig)}">
            <div class="ogt-die">${r.nat}</div>
            <div class="ogt-roll-main">
                <div class="ogt-roll-title">${esc(r.skill)} check${r.why ? `<span> · ${esc(r.why)}</span>` : ''}</div>
                <div class="ogt-roll-math">${parts.join(' ')} = <b>${r.total}</b> vs DC ${r.dc}${esc(reTxt)}</div>
            </div>
            <div class="ogt-roll-out">${OUTCOMES[r.outcome]}</div>${actions}
        </div>`;
    }

    /** Buttons shown on a failed roll while the narrator is still waiting (accepted === false). */
    function decisionHtml(chk, live) {
        if (!live || chk.accepted !== false) return '';
        const luck = getState().luck;
        return `<div class="ogt-decide"><button class="ogt-reroll-btn" ${luck > 0 ? '' : 'disabled'} title="Spend 1 Luck and roll again — you must keep the new result">🍀 Reroll · ${luck}</button>
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
        let title, math, btn;
        if (k.kind === 'attack') {
            title = `Attack · ${k.target}`; math = `${sign(k.bonus + k.mod)} to hit · AC ${k.ac}${k.spell ? ' · ' + G().terms.special : ''}`; btn = 'Roll attack';
        } else if (k.kind === 'defend') {
            title = `${k.enemy} attacks you`; math = `${sign(k.atk + k.mod)} to hit · your AC ${computeAC(getState())}`; btn = 'Defend';
        } else {
            const src = k.trained ? `skill${k.ability ? ` (${AB_NAME[k.ability]})` : ''}` : k.ability ? AB_NAME[k.ability] : 'untrained';
            const relTxt = k.rel ? ` · ${sign(k.rel)} ${k.npc ? k.npc + "'s" : 'their'} attitude` : '';
            title = `${k.skill} check`; math = `${sign(k.bonus)} ${src}${relTxt}${extra ? ' · ' + extra : ''} · DC ${k.dc}`; btn = 'Roll d20';
        }
        return `<div class="ogt-roll ogt-card ogt-check" data-kind="check" data-sig="${esc(sig)}">
            <div class="ogt-die">d20</div>
            <div class="ogt-roll-main">
                <div class="ogt-roll-title">${esc(title)}${k.why ? `<span> · ${esc(k.why)}</span>` : ''}</div>
                <div class="ogt-roll-math">${esc(math)}</div>
            </div>
            <button class="ogt-check-btn" ${live ? '' : 'disabled'}>${live ? btn : 'Expired'}</button>
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
            if (r && x.ogt_check.accepted !== false) return rollMessage(r, `${r.skill} check${x.ogt_check.why ? ` (${x.ogt_check.why})` : ''}`);
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
        const rr = res.rerolled != null ? ` (the player spent Luck to reroll; the earlier d20 was ${res.rerolled} — this is the final result)` : '';
        if (res.text) return `[ROLL] ${res.text}${rr}`;
        const bonus = res.bonus ? ` ${res.bonus >= 0 ? '+' : '−'} ${Math.abs(res.bonus)} ${res.trained ? 'skill' : res.ability ? AB_NAME[res.ability] : ''}`.trimEnd() : '';
        const mod = (res.rel ? ` ${res.rel >= 0 ? '+' : '−'} ${Math.abs(res.rel)} ${res.npc ? res.npc + "'s" : 'their'} attitude` : '')
            + (res.mod ? ` ${res.mod >= 0 ? '+' : '−'} ${Math.abs(res.mod)} situation` : '');
        const die = res.adv ? `d20 [${res.dice[0]}, ${res.dice[1]}] → ${res.nat} (${res.adv > 0 ? 'advantage' : 'disadvantage'})` : `d20 ${res.nat}`;
        const dc = res.dc == null ? '' : ` vs DC ${res.dc} — ${OUTCOME_TXT[res.outcome]}`;
        return `[ROLL] ${label}: ${die}${bonus}${mod} = ${res.total}${dc}.${rr}`;
    }

    // ── luck & rerolls ──
    // A failed roll can be rerolled by spending a Luck point BEFORE the narrator describes it (the new roll must be kept).
    const BAD_OUTCOMES = ['fail', 'badfail', 'critfail'];
    const luckOn = () => settings().luckRerolls;
    const checkLabel = (res, chk) => `${res.skill} check${chk.why ? ` (${chk.why})` : ''}`;

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
        await spinDie(btn, 'Rolling…');

        const c = ctx(), state = getState();
        chk.pre = { hp: state.hp, enemies: clone(state.enemies) }; // so a reroll can undo combat damage
        const res = resolveCheck(chk, { a: d20(), b: d20() }, state);
        chk.result = res;
        rolling = false;
        // offer a Luck reroll on a bad outcome; otherwise the result goes straight to the narrator
        const offer = luckOn() && state.luck > 0 && BAD_OUTCOMES.includes(res.outcome);
        chk.accepted = !offer;
        if (!offer) delete chk.pre;
        if (isCombat(chk)) persist({ manual: true }); else scheduleSave();
        decorateRolls();
        if (!offer) deliverRoll(rollMessage(res, checkLabel(res, chk)));
    }

    async function doReroll(btn) {
        if (rolling) return;
        const chk = locateCheck(btn, true);
        const state = getState();
        if (!chk || !(state.luck > 0)) return;
        await spinDie(btn, 'Rerolling…');

        const c = ctx(), prev = chk.result.nat;
        state.luck -= 1;
        if (chk.pre) { state.hp = chk.pre.hp; state.enemies = clone(chk.pre.enemies); } // undo the first roll's damage
        const res = resolveCheck(chk, { a: d20(), b: d20() }, state);
        res.rerolled = prev;
        chk.result = res; chk.accepted = true; delete chk.pre;
        rolling = false;
        persist({ manual: true });
        decorateRolls();
        deliverRoll(rollMessage(res, checkLabel(res, chk)));
    }

    function doAccept(btn) {
        if (rolling) return;
        const chk = locateCheck(btn, true);
        if (!chk) return;
        chk.accepted = true; delete chk.pre;
        scheduleSave();
        decorateRolls();
        deliverRoll(rollMessage(chk.result, checkLabel(chk.result, chk)));
    }

    /** Roll a skill on your own initiative (no DC — the narrator judges the total). */
    function quickRoll(skill) {
        if (isGenerating()) return window.toastr?.info('Wait for the reply to finish first.', APP_NAME);
        const nat = d20();
        const bonus = skillBonus(getState(), skill);
        const res = { skill: skill.name, trained: true, bonus, mod: 0, adv: 0, dice: [nat, nat], nat, total: nat + bonus, dc: null, outcome: null };
        window.toastr?.info(`${skill.name}: d20 ${nat} ${fmtMod(bonus)} = ${res.total}`, '🎲 Roll');
        const text = rollMessage(res, `${skill.name} (rolled on my own initiative)`);
        const c = ctx();
        const last = c.chat[c.chat.length - 1];
        if (last && !settings().showRollMsg) { last.extra = last.extra || {}; last.extra.ogt_quick = text; scheduleSave(); }
        deliverRoll(text);
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
        window.toastr?.success(`${s.name} the ${cls.name} is ready.`, APP_NAME);
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

    function itemHtml(i) {
        const equippable = ['weapon', 'armor', 'shield'].includes(i.type);
        const usable = i.type === 'potion' || i.type === 'consumable';
        return `<div class="ogt-item ${i.equipped ? 'eq' : ''}" data-iid="${esc(i.id)}" data-itype="${esc(i.type)}">
            <div class="ogt-item-head"><span class="ogt-item-name">${esc(i.name)}${i.qty > 1 ? ` <i>×${i.qty}</i>` : ''}</span>
                <span class="ogt-quest-btns">
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
            <label class="ogt-field">Panel side<select data-ogt-setting="panelSide"><option value="left" ${s.panelSide === 'left' ? 'selected' : ''}>Left</option><option value="right" ${s.panelSide === 'right' ? 'selected' : ''}>Right</option></select></label>
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
        body.innerHTML = activeTab === 'character' ? renderCharacter(state) : activeTab === 'quests' ? renderQuests(state) : activeTab === 'skills' ? renderSkills(state) : activeTab === 'gear' ? renderGear(state) : renderGM();
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
            if (settings().toasts) notes.forEach(([t, m]) => window.toastr?.[t]?.(m, APP_NAME));
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
        const root = target.closest('[data-rel],[data-qid],[data-sid],[data-iid],[data-eid]');
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
                const n = input.value.trim();
                if (n && !state.rel[n]) state.rel[n] = { value: 0, note: '' };
                input.value = '';
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
                window.toastr?.success(text, APP_NAME);
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
        if (el.dataset.ogtSetting) { render(); return; }
        if (el.dataset.ogtRelRange || el.dataset.ogtField || el.dataset.ogtStat) persist({ manual: true });
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
            const ac = e.target.closest('.ogt-accept-btn');
            if (ac) doAccept(ac);
        });
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
        window.matchMedia('(max-width: 800px)').addEventListener?.('change', render);
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
