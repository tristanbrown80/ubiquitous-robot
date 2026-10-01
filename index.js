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
    };

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
    const xpNeeded = (lvl) => 15 * lvl;
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
        };
    }

    function getState() {
        const md = ctx().chatMetadata;
        if (!md) return defaultState();
        if (!md.ogt) md.ogt = defaultState();
        return md.ogt;
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

    function applyDelta(s, d) {
        const notes = [];
        if (typeof d !== 'object' || !d) return notes;

        if (d.class) s.class = String(d.class);
        if (d.hp) s.hp = clamp(s.hp + num(d.hp), 0, s.hpMax);
        if (d.mana) s.mana = clamp(s.mana + num(d.mana), 0, s.manaMax);

        if (d.xp) {
            const gained = num(d.xp);
            s.xp += gained;
            if (gained > 0) notes.push(['info', `+${gained} XP`]);
            while (s.xp >= xpNeeded(s.level)) {
                s.xp -= xpNeeded(s.level);
                s.level += 1;
                s.hpMax += 5; s.manaMax += 2;
                s.hp = s.hpMax; s.mana = s.manaMax;
                notes.push(['success', `Level up! ${s.name} is now level ${s.level}.`]);
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
                });
                notes.push(['info', `New quest: ${a.title}`]);
            }
            for (const u of q.update || []) {
                const t = find(u?.id || u?.title);
                if (!t) continue;
                if (u.progress) t.progress = String(u.progress);
                if (u.desc) t.desc = String(u.desc);
            }
            for (const ref of q.complete || []) {
                const t = find(ref);
                if (t && t.status !== 'done') { t.status = 'done'; notes.push(['success', `Quest complete: ${t.title}`]); }
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
            quests: s.quests.filter((q) => q.status === 'active').map((q) => ({ id: q.id, title: q.title, desc: q.desc, progress: q.progress })),
        };
        const extra = settings().extraRules?.trim();
        return `[Game tracker — out-of-character system rules. Never mention or quote this block in the story.]
Current tracked state:
${JSON.stringify(compact)}

Honour this state in the narrative (injured characters act injured, NPC attitudes match their relationship tier, active quests stay relevant).

At the very END of EVERY reply, after all narrative, append exactly ONE hidden HTML comment with only the values that CHANGED this turn:
<!--OGT:{...json...}-->
Schema (omit anything unchanged; use {} content only if nothing changed — or omit the comment):
{"hp":-3,"mana":-1,"xp":10,"class":"Death Knight",
 "scene":{"region":"King's Highway","location":"North of Crosshaven Gate","time":"Morning"},
${settings().trackRel ? ' "rel":{"Vex Nightshade":{"delta":5,"note":"short reason / how they feel"}},\n' : ''} "quests":{"add":[{"id":"short_id","title":"Quest title","desc":"one line objective"}],
           "update":[{"id":"short_id","progress":"what's done / what's next"}],
           "complete":["short_id"],"fail":["short_id"]}}
Rules: hp/mana/xp are DELTAS (hp negative for damage, positive for healing). Award xp (roughly 3–25) only for meaningful achievements.${settings().trackRel ? " Relationship delta is usually -15..+15 on a -100..100 scale; use it whenever an NPC's feelings toward the player change, and add new NPCs the first time they matter." : ''} Always keep "scene" current when location or time of day changes. Valid JSON only, on a single line.${extra ? '\n' + extra : ''}`;
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
            <button class="ogt-btn ogt-wide" data-ogt-act="add-quest">Add quest</button></div>`;
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
        body.innerHTML = activeTab === 'character' ? renderCharacter(state) : activeTab === 'quests' ? renderQuests(state) : renderGM();
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
Reply with ONLY one JSON object (no prose, no code fence) containing the CHANGES missing from the tracker, using this schema (omit unchanged keys): {"hp":delta,"mana":delta,"xp":delta,"scene":{"region":"","location":"","time":""},"rel":{"NPC":{"delta":0,"note":""}},"quests":{"add":[{"id":"","title":"","desc":""}],"update":[{"id":"","progress":""}],"complete":[],"fail":[]}}. If nothing is missing reply {}.`;
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
        const root = target.closest('[data-rel],[data-qid]');
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
                state.quests.push({ id: `q${Date.now().toString(36)}`, title: t, desc: document.getElementById('ogt-new-qd').value.trim(), progress: '', status: 'active' });
                document.getElementById('ogt-new-q').value = ''; document.getElementById('ogt-new-qd').value = '';
                return persist({ manual: true });
            }
            case 'q-done': if (q) q.status = 'done'; return persist({ manual: true });
            case 'q-fail': if (q) q.status = 'failed'; return persist({ manual: true });
            case 'q-reopen': if (q) q.status = 'active'; return persist({ manual: true });
            case 'q-del': state.quests = state.quests.filter((x) => x !== q); return persist({ manual: true });
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
                        <button class="ogt-tab" data-tab="gm">Game Master</button>
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
