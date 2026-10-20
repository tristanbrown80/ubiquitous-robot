# Hearthlight (SillyTavern extension)

A tabletop-RPG layer for SillyTavern. It tracks your character, party, gear, quests and the people you meet, lets you
roll your own dice, runs turn-based combat with initiative, and gives the chat a modern look. The narrator (your AI)
tells the story; Hearthlight keeps the numbers honest. Everything is stored per chat.

## Contents

- [Install](#install) · [Quick start](#quick-start) · [The panel](#the-panel)
- [Dice, Luck and advantage](#dice-luck-and-advantage) · [Combat](#combat) · [Party and companions](#party-and-companions)
- [NPCs and relationships](#npcs-and-relationships) · [Settings](#settings-gm-tab) · [Testing tools](#testing-tools)
- [How it works](#how-it-works) · [Tips](#tips) · [Troubleshooting](#troubleshooting) · [Notes](#notes)

## Install

In SillyTavern: **Extensions → Install extension**, paste the repository URL. Updates show up as an
**Update** button in the same menu. Or copy the folder to either:

- `SillyTavern/data/<your-user>/extensions/hearthlight` (per user), or
- `SillyTavern/public/scripts/extensions/third-party/hearthlight` (all users)

Refresh the page. Open the panel with the 🔥 button (on phones it floats above the message bar), or from the
✨ extensions menu next to the message box. Both floating buttons (🔥 and ☰) can be **dragged anywhere** if they cover
text; the spot is remembered per device (phone and desktop separately). *GM tab → Reset button positions* undoes it.

## Quick start

1. Open a chat and press 🔥. On the **Character** tab choose **✦ Create your character**: pick a genre and class, then a
   name (and optionally a portrait URL and bonus skill). This sets your stats, skills and starting gear.
2. Chat normally. Each reply the narrator also reports what changed (HP, quests, NPC feelings, loot…) in a hidden tag
   that Hearthlight reads, applies and removes from the message.
3. When something uncertain happens the narrator stops and a **roll card** appears under the reply. Click to roll.
4. Add companions on the **Party** tab, and fight with the combat bar when enemies appear.

## The panel

| Tab | What it holds |
| --- | --- |
| **Character** | Portrait, class, HP / mana (or Focus / Energy), level and XP, six ability scores, AC, gold, Luck, abilities, scene, the combat tracker (initiative, action bar, enemies, attack log) and relationships. *Edit character* lets you fix any number by hand. |
| **Quests** | Active, completed and failed quests with difficulty, XP reward and milestones. Add quests by hand or let the narrator add them. |
| **Party** | Your companions: bars, ability scores, skills, abilities, carried gear, XP, tactics. See [Party](#party-and-companions). |
| **Skills** | Spend skill points from level-ups (a new skill costs 1; rank *r → r+1* costs *r+1*). **Roll** rolls a skill on your own initiative with no DC. Bonus = rank + the governing ability's modifier. |
| **Gear** | Weapons, armor, shields, potions and misc items. Equip, use, drop or hand items to a companion. AC = armor + DEX (capped by the armor) + shield. |
| **GM** | Every setting, the testing tools, the story scan and the reset. |

### Genres

Pick one in the character creator. Each has its own classes, starting kits, skill list and wording (Mana ↔ Focus ↔
Energy, gold ↔ cash), and the narrator is told the setting. More genres are just data.

- **Fantasy** — Warrior, Rogue, Mage, Cleric, Ranger, Bard, Death Knight
- **Modern** — Soldier, Detective, Hacker, Medic, Fixer, Driver, Brawler (firearms, vehicles, hacking; no magic)
- **Slice of Life** — Socialite, Performer, Counselor, Overachiever, Rebel, Organizer, Artist. A **no-combat** genre: HP,
  armor, weapons, enemies and the whole combat layer disappear. Conflict is social checks and relationships (which move
  to the front of the panel), and failure costs trust or reputation, never health.

You can also turn combat off **per chat** in any genre: *GM tab → Combat system for this chat*. Turning it off removes the
combat UI and the combat rules from the prompt (saving tokens) and clears any fight in progress.

### Quests and XP

The narrator picks a quest's difficulty (trivial 5 · easy 10 · medium 20 · hard 35 · deadly 60 XP). The **game** pays the
XP when a quest completes, so the model cannot hand out arbitrary levels. Up to three milestones per quest pay 20% each
early. Levels grant HP and mana, skill points and every other level an ability point. Level-ups and quest completions can
also earn a Luck point. *XP source* in the GM tab can allow small bonus XP or let the model decide.

## Dice, Luck and advantage

In **click-to-roll** mode (default) the narrator stops at uncertain moments and a roll card appears under the reply. The
result goes back to the narrator invisibly (or as a chat message if you turn on *Show roll results as a chat message*).

- **Check types:** skill checks, raw ability checks (e.g. Charisma), and social checks that include an NPC's attitude.
  Natural 20 always succeeds, natural 1 always fails; beating the DC by 5+ is a strong success, missing by 5+ a bad failure.
- **Luck rerolls:** after a failed roll you can spend 1 Luck to reroll. You can keep rerolling while you have Luck, but each
  new result must be kept. Combat damage from a rerolled attack is undone and re-rolled.
- **Advantage / disadvantage:** the narrator can grant either for strong situations (shown on the card). Before rolling you
  can also spend 1 Luck on **🍀 Advantage** (it cancels disadvantage). On an enemy's attack the button imposes
  disadvantage on the attacker instead.
- **Who rolls:** on a pending skill check with companions in the party, **Rolled by** lets any ally take the check using
  their own skill rank and ability scores (the dropdown shows each bonus), and **Help** lets an ally with that skill add
  +1 per two ranks (max +3). The narrator is told who rolled and who helped. (Click-to-roll mode only.)
- **Automatic mode** (*Roll mode* setting): the game rolls for you before each reply. Combat, Luck and ally rolls need
  click-to-roll.

## Combat

The game tracks enemy HP, rolls attacks and damage, and applies results; the narrator describes them. Combat is available
in every genre except Slice of Life, unless you switch it off for the chat.

**Enemies.** The narrator registers each enemy with HP, AC, a to-hit bonus and a damage die. Enemies without stats get
level-based defaults. Enemy cards show HP and "+N to hit · damage". Notable enemies can also have a **behavior**
(*brute*, *cowardly* — flees when badly hurt, *caster* — favors its special) and one **special** (a stronger attack or a
self-heal with a cooldown in rounds; the card shows "recharging" between uses).

**Initiative.** When a live enemy exists, everyone rolls initiative (d20 + DEX modifier; enemies get a small bonus from their AC) and the **Initiative** list shows
the order, the current turn and the round. *Next turn ›* advances by hand; 🎲 rerolls initiative. Combatants who go down
drop out of the order; new enemies join it automatically.

**The action bar.** On a turn you control (yours, or a companion you play) the bar appears with:

| Action | What it does |
| --- | --- |
| **⚔ Attack** | Weapon attack on the selected enemy. Creates a normal roll card, so Luck rerolls and advantage work. |
| **Abilities** | Each shows its mana cost and damage (or healing). Attack abilities roll to hit and cost mana even on a miss; heal abilities target the selected ally and resolve at once. |
| **Item** | Use a potion or consumable on the selected ally. |
| **🛡 Defend** | Attacks against you have disadvantage until your next turn. |
| **🏃 Flee** | Whole-party DEX check against a DC of 8 + 2 per living enemy (10–20). Success ends the fight. |
| **Something else…** | Free text, sent to the narrator to adjudicate (does not end your turn). |

An action ends the turn once its result is final. Pick the **Enemy** and **Ally** targets from the dropdowns above the
buttons. The narrator receives each result and narrates it.

**Targeting.** Pending attack cards have a **Target** dropdown. Enemy attacks can be aimed at a companion; the game then
rolls against *their* AC and applies the damage to them.

**Attack log.** A running summary (your hits, damage dealt and taken) plus the last eight attacks, reset each fight.

**Auto-play.** Turn on *Auto-play enemy turns* and the game rolls every enemy turn itself, using each enemy's stats and
attacking the most wounded target most of the time, and sends the narrator **one summary** instead of one request per
attack. Companions you do not control are played by the game too (see Tactics below). If auto-play is off, press
**▶ Run turns** whenever it is a game-played turn to run them on demand.

**Smart enemies (optional, off by default).** With *Smart enemies* on, each round of automatic enemy turns starts with one
tiny API call that has **no chat history**: just the round, who is on each side, and each enemy's HP, behavior and whether its
special is ready (a few hundred tokens). The AI answers with a short JSON choice per enemy — attack, special or flee, a
target, and a one-line description — which appears in the summary the narrator receives. It can only choose from that menu:
the game still rolls every hit and damage, ignores impossible choices (a dead target, a special on cooldown, fleeing while
healthy) and falls back to the built-in enemy AI if the call fails or times out (15 s). Needs a SillyTavern version that
exposes `generateRaw`.

**Abilities** are named actions with a mana cost and a dice expression (e.g. *Fireball, 3 mana, 2d6* or *Mend, 2 mana,
heals 1d8*). Add them under *Edit character → Abilities* (yours) or in a companion's open card. Casters start with one
basic special attack.

## Party and companions

The **Party** tab holds up to six companions. Add one with the form at the bottom (name, class, level, HP, mana, AC,
skills) or let the narrator add them when someone joins you.

Each companion has:

- **HP, mana and AC.** AC comes from a *base AC* plus what they wear: equipped armor replaces the base, a shield adds to it.
- **Ability scores** (STR…CHA), editable, used for skill checks, attacks and initiative.
- **Skills** with ranks (`Stealth 3, Lockpicking 2`).
- **Abilities** with mana cost and damage or healing (same as yours).
- **Gear.** Their own bag. Equip a weapon, armor or shield (one of each); a wielded weapon sets their attack bonus and
  damage dice. Items can be handed back and forth (below).
- **Leveling.** Companions earn the same XP you do. Each level adds HP and mana, every even level raises their best
  ability score and top skill, and they are fully healed. Toggle with *Companions earn the same XP*.
- **Tactics.** Who plays their turns (default / me via the action bar / the game) and, for game-played turns, a stance:
  *Balanced* (attacks, heals under 50%), *Aggressive* (strongest ability, heals under 25%), *Defensive* (guards when hurt),
  *Support* (heals under 75%, saves mana for it), plus an optional **focus target**.
- **Quick tools** when a card is open: HP −5/−1/+1/+5, mana ±1, full heal.

**Handing over gear.** Every item row has a **Give to…** dropdown (your Gear tab and each companion's *Carrying* list). Pick
a recipient and, for stacks, how many. Equipped items are unequipped on the way. If a companion leaves the party their gear
returns to your pack.

## NPCs and relationships

NPCs are tracked as feelings from **Hostile** to **Devoted** (−100…+100) with a short note, shown as tiers. The game limits
each reply to ±25 per NPC, and a social check adds the NPC's attitude.

The tracker keeps **one entry per person**:

- "Miranda" and "Miranda Voss" resolve to the same NPC; the entry takes the fuller name and remembers the other as an
  alias ("aka Miranda"). Different people who share a first name ("Miranda Voss" / "Miranda Cole") are never guessed — the
  game warns and asks the narrator for the full name.
- The narrator can send `{"Miranda":{"rename":"Miranda Voss"}}` or `{"alias":"Ms. Voss"}`, and is shown every tracked
  name (beyond the top twelve by name only) so it does not introduce someone twice.
- If duplicates already exist, **Merge N likely duplicates** merges them in one click, and each NPC card has a
  **Merge into…** dropdown for anything else. The stronger feeling and longer note are kept.

## Settings (GM tab)

| Setting | Effect |
| --- | --- |
| Enable tracking / Inject tracker rules | Master switches for the extension and its prompt injection. |
| Toasts | Level-up, quest and event pop-ups. |
| Modern chat theme / Hide top icon row | The look; the icon row moves behind a ☰ button. |
| XP source · XP multiplier | Quests only (recommended), quests + small bonus, or model decides; scales all XP. |
| Skill points per level · Max skill rank | Progression pacing. |
| Let the story unlock new skills | The narrator can grant a free rank-1 skill when you truly learn one. |
| Track NPC relationship scores | NPC tiers and social-check bonuses. |
| **Combat system for this chat** | Per chat. Off = roleplay-only: no HP, enemies, initiative or attacks. |
| Track party members | Enables the Party tab and companion rules. |
| **Auto-play enemy turns** | The game rolls enemy (and game-played ally) turns and sends one summary. |
| **Smart enemies** | Each round of enemy turns, one tiny no-history API call picks their actions; falls back to the built-in AI. |
| Companions' turns are mine by default | On = action bar; off = the game plays them. Each ally can override this. |
| Companions earn XP | Allies share your XP and level up. |
| Panel side · Reset button positions | Where the panel sits; undo dragged buttons. |
| Default genre | Pre-selected in the character creator. |
| Dice · Luck rerolls · Roll mode | Roll cards, Luck, and click-to-roll vs automatic. |
| Show roll results as a chat message | Visible `[ROLL]` messages instead of hidden ones. |
| Auto-scan when a reply has no tag | An extra API call to recover missed updates. |
| Injection depth · Extra GM rules | Where the rules are inserted; your own standing instructions. |
| Testing tools | Reveals the [testing section](#testing-tools). |
| Scan story / Reset tracker | Recover missed updates from the story; wipe this chat's state. |

## Testing tools

Tick **Testing tools** in the GM tab to reveal a debugging section (nothing it does applies while it is unticked):

- **Infinite Luck** — rerolls and advantage cost nothing.
- **Force every d20 to** 1, 5, 10, 15 or 20 — test crits, fumbles and DC edges.
- **Don't send roll results to the narrator** — resolve rolls without an API call.
- **Shortcuts** — full HP/mana, max Luck, +100 XP, level up, +1000 gold, +5 skill / +2 ability points, add or clear a test
  enemy.
- **Spawn a roll card** on the latest message: skill check (also with advantage or disadvantage), your attack, an enemy
  attack, an enemy attack on an ally, or remove the card.

## How it works

Each turn the extension injects your current state plus rules into the prompt. The model ends its reply with a hidden
`<!--OGT:{...}-->` comment containing only what changed. Hearthlight parses it, removes it from the message, applies it
(with limits on how much one reply can change), and keeps a snapshot so swipes, regenerates and deletes roll the tracker back
correctly. For long chats it keeps snapshots for recent replies plus sparse checkpoints and saves with a single debounced
write.

The tag can carry: `hp`, `mana`, `xp`, `class`, `scene`, `rel` (delta, set, note, rename, alias), `inv` (add, remove,
gold), `skills.unlock`, `enemies` (add with `atk`/`dmg`, remove, clear), `quests` (add, update, complete, fail), `party`
(add, update, transfer, remove), `attacks` (log-only enemy attacks), `initiative.next`, and `check` / `roll` requests. A tag
cut off by the model's token limit is repaired automatically, and the panel tells you when it had to.

The game, not the model, owns the dice, damage, XP payouts, AC and turn order. Updates are clamped (HP, XP, relationship
swings, text lengths, counts) so a confused reply cannot wreck the sheet.

## Tips

- **Saving tokens:** turn off *Combat system* for roleplay-only chats, switch off *Track party members* if you do not use
  companions, and keep *Extra GM rules* short. Long chats trim the tracked state automatically (most significant NPCs first,
  recent quests only).
- **Model behaviour:** works best with models that follow format instructions. For the cleanest combat, enable
  *Auto-play enemy turns* so the model only narrates results.
- **Phones:** the panel opens full screen, the 🔥 button floats above the message bar, and both floating buttons can be moved.

## Troubleshooting

- **Tag text is visible in the chat / nothing updates:** open the GM tab; the status line shows what the last reply did. Use
  **Scan story for missed updates** to recover, or enable the auto-scan. Truncated tags are repaired, but a model that never
  writes the tag needs a stronger model or the scan.
- **"Tracker tag was cut off" toast:** the reply hit the token limit before finishing the tag. Raise the response length.
- **Duplicate NPCs:** use *Merge N likely duplicates* or *Merge into…* on the Relationships list.
- **Buttons in the way:** drag them; *Reset button positions* restores the defaults.
- **Combat bar missing:** it only shows on a turn you control while a fight is active; on enemy turns press **▶ Run turns** or
  *Next turn ›*.
- **Something looks wrong after a swipe:** state rolls back to the previous reply's snapshot; hand edits are kept.

## Notes

- State lives in chat metadata (`chatMetadata.ogt`); settings in `extension_settings.hearthlight`. Settings saved under the
  earlier name (`old_gregs_tavern`) are migrated automatically. Button positions and panel open/closed are stored in your
  browser (per device).
- Combat, Luck, ally rolls and the action bar need click-to-roll mode.
- Needs `SillyTavern.getContext()` (SillyTavern 1.12+).
