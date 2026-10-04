# Hearthlight (SillyTavern extension)

A tabletop-RPG layer for SillyTavern. It tracks your character, gear, quests and the people you meet,
lets you roll your own dice, and gives the chat a modern look. Everything is stored per chat.

## Features

- **Character sheet** — class, level and XP, HP / Mana, six D&D-style ability scores, derived Armor Class,
  Luck points. Pregen classes via the **character creator** (Warrior, Rogue, Mage, Cleric, Ranger, Bard, Death Knight).
- **Quests & XP** — the narrator picks a difficulty; the game pays the XP when a quest completes (with optional milestones).
- **Skills** — spend skill points from level-ups. Skill bonus = rank + the governing ability's modifier.
- **Gear** — weapons, armor, shields, potions; equip and use them from the panel. AC comes from armor + DEX + shield.
- **Dice** — the narrator stops at uncertain moments and asks for a check; you click to roll. Skill checks, raw
  ability checks (e.g. Charisma), social checks that include an NPC's attitude, and a **Luck** reroll for failures.
- **Combat** — the game tracks enemy HP, rolls your attacks and damage, and rolls enemy attacks against your AC.
- **Relationships** — NPCs shown as tiers from Hostile to Devoted.
- **Look** — a modern chat theme, the top icon row tucked behind a menu button, and a phone-friendly layout.

## Install

In SillyTavern: **Extensions → Install extension**, paste the repository URL. Updates show up as an
**Update** button in the same menu. Or copy the folder to either:

- `SillyTavern/data/<your-user>/extensions/hearthlight` (per user), or
- `SillyTavern/public/scripts/extensions/third-party/hearthlight` (all users)

Refresh the page. Open the panel with the 🔥 button (on phones it floats above the message bar), or from the
✨ extensions menu next to the message box.

## How it works

Each turn the extension injects your current state plus rules into the prompt. The model ends its reply with a
hidden `<!--OGT:{...}-->` comment (only what changed). The extension parses it, removes it from the message,
applies it, and keeps a snapshot so swipes, regenerates and deletes roll the tracker back correctly.
For long chats it keeps snapshots only for recent replies plus sparse checkpoints, and saves with a single
debounced write.

Dice are click-to-roll: the model asks for a check, you press **Roll**, and the result is passed back to the
narrator invisibly (or as a chat message if you prefer — see the GM tab).

## Settings (GM tab)

Tracking on/off, prompt injection, theme, menu button, XP source and multiplier, skill points per level,
dice mode (click-to-roll or automatic), Luck rerolls, relationship tracking, panel side, extra GM rules,
a "scan story for missed updates" button, and a reset.

## Notes

- Works best with models that follow format instructions. If a model forgets the tag, use the scan button.
- State lives in chat metadata (`chatMetadata.ogt`); settings in `extension_settings.hearthlight`.
  Settings saved under the earlier name (`old_gregs_tavern`) are migrated automatically.
- Combat and Luck need click-to-roll mode.
- Needs `SillyTavern.getContext()` (SillyTavern 1.12+).
