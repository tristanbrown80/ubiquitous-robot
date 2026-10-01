/* Old Greg's Tavern — SillyTavern extension
 * Tracks character stats / level, NPC relationships and quests per chat,
 * and shows them in an Old-Greg's-style side panel.
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

    const MODULE = 'old_gregs_tavern';
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
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (extensionSettings[MODULE][k] === undefined) extensionSettings[MODULE][k] = v;
        }
        return extensionSettings[MODULE];
    }
    const saveSettings = () => ctx().saveSettingsDebounced();

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
        };
    }

    function getState() {
        const md = ctx().chatMetadata;
        if (!md) return defaultState();
        if (!md.ogt) md.ogt = defaultState();
        // older saves / snapshots predate skills
        if (!Array.isArray(md.ogt.skills)) md.ogt.skills = [];
        if (!Number.isFinite(md.ogt.skillPoints)) md.ogt.skillPoints = 0;
        return md.ogt;
    }

    // ───────────────────────── skills ─────────────────────────
    // A new skill costs 1 point (rank 1). Raising rank r → r+1 costs r+1 points. Total to master (5) = 15.
    const rankUpCost = (rank) => rank + 1;
    const spentOn = (sk) => (sk.rank * (sk.rank + 1)) / 2 - (sk.free ? 1 : 0);
    const RANK_NAMES = ['Untrained', 'Novice', 'Apprentice', 'Skilled', 'Expert', 'Master'];
    const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const PRESET_SKILLS = [
        ['Swordsmanship', 'Melee combat with blades.'], ['Archery', 'Bows, crossbows and thrown weapons.'],
        ['Stealth', 'Moving unseen and unheard, picking pockets.'], ['Persuasion', 'Convincing, bargaining, charm.'],
        ['Intimidation', 'Threats, presence, breaking morale.'], ['Lore', 'History, languages, arcane and religious knowledge.'],
        ['Survival', 'Tracking, foraging, navigation, weather.'], ['Alchemy', 'Potions, poisons and reagents.'],
        ['Magic', 'Channeling mana into spells.'], ['Smithing', 'Forging and repairing arms and armor.'],
        ['Medicine', 'Treating wounds and illness.'], ['Lockpicking', 'Locks, traps and mechanisms.'],
    ];

    function addSkill(s, name, desc = '', { free = false } = {}) {
        const id = slug(name);
        if (!id || s.skills.some((k) => k.id === id)) return null;
        const sk = { id, name: String(name).slice(0, 40), desc: String(desc || '').slice(0, 160), rank: 1, free };
        s.skills.push(sk);
        return sk;
    }

    function persist({ manual = false } = {}) {
        const c = ctx();
        const md = c.chatMetadata;
        if (!md) return;
        if (manual) {
            // keep hand edits alive across swipe/delete resyncs
            md.ogt_base = clone(md.ogt);
            const last = [...c.chat].reverse().find((m) => m.extra?.ogt_snap);
            if (last) last.extra.ogt_snap = clone(md.ogt);
            c.saveChat?.();
        }
        c.saveMetadata();
        refreshPrompt();
        render();
    }

    /** Rebuild live state from the newest message snapshot (optionally ignoring the last message). */
    function syncFromChat(excludeLast = false) {
        const c = ctx();
        const md = c.chatMetadata;
        if (!md) return;
        const chat = excludeLast ? c.chat.slice(0, -1) : c.chat;
        const snapMsg = [...chat].reverse().find((m) => m.extra?.ogt_snap);
        md.ogt = snapMsg ? clone(snapMsg.extra.ogt_snap) : clone(md.ogt_base || defaultState());
        refreshPrompt();
        render();
    }

    // ───────────────────────── applying model updates ─────────────────────────

    /** Add XP (scaled by the XP multiplier unless raw) and process level-ups. */
    function gainXp(s, amount, notes, label = '') {
        const gained = Math.round(amount * num(settings().xpMult, 1));
        if (gained <= 0) return 0;
        s.xp += gained;
        notes.push(['info', `+${gained} XP${label ? ' — ' + label : ''}`]);
        while (s.xp >= xpNeeded(s.level)) {
            s.xp -= xpNeeded(s.level);
            s.level += 1;
            s.hpMax += 5; s.manaMax += 2;
            s.hp = s.hpMax; s.mana = s.manaMax;
            const pts = Math.max(0, Math.round(num(settings().pointsPerLevel, 2)));
            s.skillPoints = (s.skillPoints || 0) + pts;
            notes.push(['success', `Level up! ${s.name} is now level ${s.level}.${pts ? ` +${pts} skill points.` : ''}`]);
        }
        return gained;
    }

    const questReward = (q) => num(q.xp, DIFFICULTY[normDiff(q.difficulty)]);

    /** Mark a quest done and pay its reward once (re-opening and re-completing never double-pays). */
    function completeQuest(s, q, notes) {
        if (q.status === 'done') return;
        q.status = 'done';
        notes.push(['success', `Quest complete: ${q.title}`]);
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

        // the model may unlock a skill when the player genuinely learns one in the story (rank 1, free, max 1 per turn)
        if (d.skills?.unlock && settings().modelUnlockSkills) {
            const u = [].concat(d.skills.unlock)[0];
            const name = typeof u === 'string' ? u : u?.name;
            if (name && !(s.skills || (s.skills = [])).some((k) => k.id === slug(name))) {
                if (addSkill(s, name, u?.desc, { free: true })) notes.push(['success', `New skill learned: ${name}`]);
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

    function parseTags(text) {
        const deltas = [];
        let m;
        TAG_RE.lastIndex = 0;
        while ((m = TAG_RE.exec(text))) {
            const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/^```(?:json)?|```$/g, '').trim();
            try { deltas.push(JSON.parse(raw)); } catch (e) { console.warn(`[${MODULE}] bad OGT json`, raw); }
        }
        return deltas;
    }

    function onMessageReceived(id) {
        const s = settings();
        if (!s.enabled) return;
        const c = ctx();
        const msg = c.chat[id];
        if (!msg || msg.is_user || msg.is_system || typeof msg.mes !== 'string') return;
        if (!new RegExp(TAG_RE.source, 'i').test(msg.mes)) {
            lastStatus = 'Last reply had NO tracker tag' + (s.autoScan ? ' — auto-scanning…' : '.');
            console.warn(`[${MODULE}] no OGT tag in reply`, msg.mes.slice(-200));
            if (s.autoScan) setTimeout(() => scanStory({ silent: true }), 1500);
            return render();
        }
        lastStatus = 'Last reply: tracker tag found and applied.';

        const state = getState();
        const notes = [];
        for (const d of parseTags(msg.mes)) notes.push(...applyDelta(state, d));

        msg.mes = msg.mes.replace(TAG_RE, '').trimEnd();
        msg.extra = msg.extra || {};
        msg.extra.ogt_snap = clone(state);

        try { c.updateMessageBlock?.(id, msg); } catch (e) { /* message may not be rendered yet */ }
        c.saveChat?.();
        persist();
        if (s.toasts) notes.forEach(([type, text]) => window.toastr?.[type]?.(text, "Old Greg's Tavern"));
    }

    // ───────────────────────── prompt injection ─────────────────────────

    function buildPrompt() {
        const s = getState();
        const compact = {
            player: s.name, class: s.class, level: s.level, xp: `${s.xp}/${xpNeeded(s.level)}`,
            hp: `${s.hp}/${s.hpMax}`, mana: `${s.mana}/${s.manaMax}`,
            scene: s.scene,
            relationships: !settings().trackRel ? undefined : Object.fromEntries(Object.entries(s.rel).map(([n, r]) => [n, `${r.value} (${tierOf(r.value)})${r.note ? ' - ' + r.note : ''}`])),
            skills: Object.fromEntries((s.skills || []).map((k) => [k.name, `${k.rank}/${settings().skillMaxRank} ${RANK_NAMES[k.rank] || ''}`])),
            quests: s.quests.filter((q) => q.status === 'active').map((q) => ({ id: q.id, title: q.title, desc: q.desc, progress: q.progress, difficulty: q.difficulty, reward: `${questReward(q)} XP` })),
        };
        const extra = settings().extraRules?.trim();
        return `[Game tracker — out-of-character system rules. Never mention or quote this block in the story.]
Current tracked state:
${JSON.stringify(compact)}

Honour this state in the narrative (injured characters act injured, NPC attitudes match their relationship tier, active quests stay relevant). Skills are the player's real competence: rank 1 = novice, 5 = master. Let outcomes reflect them — a rank-1 skill fumbles under pressure, a rank-5 skill is reliable — and never let the player perform feats far above their rank or level without consequence. Skill ranks are raised by the player with skill points, not by you.

At the very END of EVERY reply, after all narrative, append exactly ONE hidden HTML comment with only the values that CHANGED this turn:
<!--OGT:{...json...}-->
Schema (omit anything unchanged; use {} content only if nothing changed — or omit the comment):
{"hp":-3,"mana":-1,${settings().xpMode === 'quests' ? '' : '"xp":5,'}"class":"Death Knight",
 "scene":{"region":"King's Highway","location":"North of Crosshaven Gate","time":"Morning"},
${settings().trackRel ? ' "rel":{"Vex Nightshade":{"delta":5,"note":"short reason / how they feel"}},\n' : ''}${settings().modelUnlockSkills ? ' "skills":{"unlock":[{"name":"Lockpicking","desc":"one line"}]},\n' : ''} "quests":{"add":[{"id":"short_id","title":"Quest title","desc":"one line objective","difficulty":"trivial|easy|medium|hard|deadly"}],
           "update":[{"id":"short_id","progress":"what's done / what's next","milestone":true}],
           "complete":["short_id"],"fail":["short_id"]}}
Rules: hp${settings().xpMode === 'quests' ? '/mana are' : '/mana/xp are'} DELTAS (hp negative for damage, positive for healing). ${settings().xpMode === 'quests'
    ? 'Do NOT award xp yourself — the game pays XP automatically when a quest is completed. When a quest begins, pick its "difficulty" honestly relative to the player\'s level (trivial: errand; easy: minor risk; medium: real danger or effort; hard: serious threat; deadly: likely lethal). Add "milestone":true to a quest update only when a major objective step is genuinely finished (max 3 per quest). Put a quest id in "complete" only when its goal is fully achieved.'
    : 'Award xp (roughly 3–10) only for meaningful achievements; quest completion is paid automatically from the quest\'s difficulty.'}${settings().trackRel ? " Relationship delta is usually -15..+15 on a -100..100 scale; use it whenever an NPC's feelings toward the player change, and add new NPCs the first time they matter." : ''}${settings().modelUnlockSkills ? ' Use "skills.unlock" only when the player actually learns a brand-new skill through in-story training or discovery (at most one per turn; never for skills they already have).' : ''} Always keep "scene" current when location or time of day changes. Valid JSON only, on a single line.${extra ? '\n' + extra : ''}`;
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

    function renderCharacter(s) {
        const av = avatarUrl(s);
        const field = (k, label, type = 'number') =>
            `<label>${label}<input data-ogt-field="${k}" type="${type}" value="${esc(s[k])}"></label>`;
        let h = `<div class="ogt-card">
            <div class="ogt-portrait" style="${av ? `background-image:url('${esc(av)}')` : ''}">${av ? '' : `<span>${esc(s.name[0] || '?')}</span>`}</div>
            <div class="ogt-card-text"><div class="ogt-name">${esc(s.name)}</div><div class="ogt-class">${esc(s.class)}</div></div>
        </div>
        <div class="ogt-stats">
            ${bar('HP', 'hp', s.hp, s.hpMax)}
            ${bar('MANA', 'mana', s.mana, s.manaMax)}
            ${bar(`LVL ${s.level}`, 'xp', s.xp, xpNeeded(s.level))}
        </div>`;

        if (s.skillPoints > 0) {
            h += `<button class="ogt-btn ogt-wide ogt-spend" data-ogt-act="goto-skills">${s.skillPoints} skill point${s.skillPoints === 1 ? '' : 's'} to spend ›</button>`;
        }

        if (s.scene.location || s.scene.region || s.scene.time) {
            h += `<div class="ogt-scene"><div class="ogt-scene-top">${esc([s.scene.region, s.scene.time].filter(Boolean).join(' · '))}</div>
                <div class="ogt-scene-loc">${esc(s.scene.location)}</div></div>`;
        }

        h += `<button class="ogt-btn ogt-wide" data-ogt-act="toggle-edit">${editingChar ? 'Done editing' : 'Edit character'}</button>`;
        if (editingChar) {
            h += `<div class="ogt-form">
                ${field('name', 'Name', 'text')}${field('class', 'Class', 'text')}${field('avatar', 'Portrait URL', 'text')}
                ${field('level', 'Level')}${field('xp', 'XP')}
                ${field('hp', 'HP')}${field('hpMax', 'Max HP')}${field('mana', 'Mana')}${field('manaMax', 'Max mana')}
            </div>`;
        }

        if (!settings().trackRel) return h;
        h += `<div class="ogt-section">RELATIONSHIPS</div>`;
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

    function skillHtml(k, pts, max) {
        const pips = Array.from({ length: max }, (_, i) => `<i class="${i < k.rank ? 'on' : ''}"></i>`).join('');
        const cost = rankUpCost(k.rank);
        const canUp = k.rank < max && pts >= cost;
        return `<div class="ogt-skill" data-sid="${esc(k.id)}">
            <div class="ogt-skill-head"><span class="ogt-skill-name">${esc(k.name)}</span>
                <span class="ogt-quest-btns"><button class="ogt-btn small" data-ogt-act="skill-up" ${canUp ? '' : 'disabled'} title="Costs ${cost} point${cost > 1 ? 's' : ''}">${k.rank >= max ? 'MAX' : `+ ${cost}`}</button>
                <button class="ogt-btn small" data-ogt-act="skill-del" title="Forget (refunds points)">✕</button></span></div>
            <div class="ogt-pips">${pips}<span class="ogt-xpchip">${esc(RANK_NAMES[k.rank] || '')}</span></div>
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
        const left = PRESET_SKILLS.filter(([n]) => !have.has(slug(n)));
        if (left.length) {
            h += `<div class="ogt-section">LEARN A SKILL (1 POINT)</div><div class="ogt-chips">${left.map(([n, d]) => `<button class="ogt-chip" data-ogt-act="skill-preset" data-name="${esc(n)}" data-desc="${esc(d)}" ${pts < 1 ? 'disabled' : ''} title="${esc(d)}">${esc(n)}</button>`).join('')}</div>`;
        }
        h += `<div class="ogt-form"><input id="ogt-new-sk" placeholder="Custom skill name"><input id="ogt-new-skd" placeholder="What it covers (optional)">
            <button class="ogt-btn ogt-wide" data-ogt-act="skill-add" ${pts < 1 ? 'disabled' : ''}>Learn custom skill</button>
            ${s.skills.length ? `<button class="ogt-btn ogt-wide danger" data-ogt-act="skill-respec">Respec all skills</button>` : ''}</div>`;
        return h;
    }

    function renderGM() {
        const s = settings();
        const chk = (k, label) => `<label class="ogt-check"><input type="checkbox" data-ogt-setting="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`;
        return `<div class="ogt-section">GAME MASTER</div>
            ${chk('enabled', 'Enable tracking')}
            ${chk('inject', 'Inject tracker rules into prompt')}
            ${chk('toasts', 'Show level-up / quest toasts')}
            ${chk('theme', 'Modern Old Greg\'s chat theme')}
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
        panel.classList.toggle('open', s.panelOpen);
        document.getElementById('ogt-toggle')?.classList.toggle('open', s.panelOpen);
        if (!ctx().chatMetadata) {
            panel.querySelector('.ogt-body').innerHTML = `<div class="ogt-empty">Open a chat to begin.</div>`;
            return;
        }
        const state = getState();
        panel.querySelectorAll('.ogt-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === activeTab));
        const active = document.activeElement;
        if (active && panel.contains(active) && /INPUT|TEXTAREA/.test(active.tagName) && active.type !== 'range' && active.type !== 'checkbox') return; // don't clobber typing
        const body = panel.querySelector('.ogt-body');
        const scroll = body.scrollTop;
        body.innerHTML = activeTab === 'character' ? renderCharacter(state) : activeTab === 'quests' ? renderQuests(state) : activeTab === 'skills' ? renderSkills(state) : renderGM();
        body.scrollTop = scroll;
    }

    // ───────────────────────── actions ─────────────────────────

    let scanning = false;
    async function scanStory({ silent = false } = {}) {
        const c = ctx();
        if (scanning) return;
        if (!c.generateQuietPrompt) return window.toastr?.error('generateQuietPrompt not available in this SillyTavern version.');
        scanning = true;
        if (!silent) window.toastr?.info('Scanning recent story…', "Old Greg's Tavern");
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
            if (settings().toasts) notes.forEach(([t, m]) => window.toastr?.[t]?.(m, "Old Greg's Tavern"));
            if (!silent) window.toastr?.success('Tracker updated.', "Old Greg's Tavern");
        } catch (e) {
            console.error(`[${MODULE}] scan failed`, e);
            lastStatus = 'Scan failed (see console).';
            if (!silent) window.toastr?.error('Could not parse the scan result.', "Old Greg's Tavern");
        } finally {
            scanning = false;
            render();
        }
    }

    function onClick(e) {
        const target = e.target.closest('[data-ogt-act], .ogt-tab, #ogt-close');
        if (!target) return;
        if (target.id === 'ogt-close') { settings().panelOpen = false; saveSettings(); return render(); }
        if (target.classList.contains('ogt-tab')) { activeTab = target.dataset.tab; return render(); }

        const state = getState();
        const act = target.dataset.ogtAct;
        const root = target.closest('[data-rel],[data-qid],[data-sid]');
        const skill = root?.dataset.sid ? state.skills.find((k) => k.id === root.dataset.sid) : null;
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
                if (settings().toasts) notes.forEach(([t, m]) => window.toastr?.[t]?.(m, "Old Greg's Tavern"));
                return;
            }
            case 'q-fail': if (q) q.status = 'failed'; return persist({ manual: true });
            case 'q-reopen': if (q) q.status = 'active'; return persist({ manual: true });
            case 'q-del': state.quests = state.quests.filter((x) => x !== q); return persist({ manual: true });
            case 'goto-skills': activeTab = 'skills'; return render();
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
                if (!name || !addSkill(state, name, desc)) return;
                state.skillPoints -= 1;
                return persist({ manual: true });
            }
            case 'skill-respec':
                if (confirm('Refund all spent skill points and forget every skill?')) {
                    state.skills.forEach((k) => { state.skillPoints += spentOn(k); });
                    state.skills = [];
                    return persist({ manual: true });
                }
                return;
            case 'scan': return scanStory();
            case 'reset':
                if (confirm('Reset all tracked stats, relationships and quests for this chat?')) {
                    const md = ctx().chatMetadata;
                    md.ogt = defaultState(); md.ogt_base = clone(md.ogt);
                    ctx().chat.forEach((m) => { if (m.extra) delete m.extra.ogt_snap; });
                    ctx().saveChat?.();
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
            ctx().saveMetadata(); refreshPrompt();
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
    }

    function onChange(e) {
        const el = e.target;
        if (el.dataset.ogtSetting) { render(); return; }
        if (el.dataset.ogtRelRange || el.dataset.ogtField) persist({ manual: true });
    }

    // ───────────────────────── boot ─────────────────────────

    function buildUI() {
        if (document.getElementById('ogt-panel')) return;
        document.body.insertAdjacentHTML('beforeend', `
            <button id="ogt-toggle" title="Old Greg's Tavern"><i class="fa-solid fa-beer-mug-empty"></i></button>
            <aside id="ogt-panel">
                <div class="ogt-head">
                    <div class="ogt-tabs">
                        <button class="ogt-tab" data-tab="character">Character</button>
                        <button class="ogt-tab" data-tab="quests">Quests</button>
                        <button class="ogt-tab" data-tab="skills">Skills</button>
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
        document.getElementById('ogt-toggle').addEventListener('click', () => {
            settings().panelOpen = !settings().panelOpen; saveSettings(); render();
        });
    }

    function init() {
        settings();
        buildUI();
        applyTheme();
        const { eventSource, eventTypes } = ctx();
        eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(eventTypes.CHAT_CHANGED, () => { editingChar = false; expandedRel.clear(); syncFromChat(); });
        eventSource.on(eventTypes.MESSAGE_DELETED, () => syncFromChat());
        eventSource.on(eventTypes.MESSAGE_SWIPED, () => syncFromChat(true));
        eventSource.on(eventTypes.GENERATION_STARTED, (type, _p, dry) => {
            if (dry) return;
            if (type === 'swipe' || type === 'regenerate') syncFromChat(true);
            refreshPrompt();
        });
        syncFromChat();
        console.log(`[${MODULE}] loaded`);
    }

    const c0 = ctx();
    c0.eventSource.on(c0.eventTypes.APP_READY, init);
    if (document.getElementById('send_textarea')) init(); // already ready (late load)
})();
