# Old Greg's Tavern (SillyTavern extension)

Adds an Old-Greg's-style side panel to SillyTavern that tracks, per chat:

- **Character** — name, class, portrait, HP / Mana / XP bars, level (auto level-ups: +5 max HP, +2 max mana, full heal)
- **Relationships** — NPCs with a -100..100 score shown as tiers (Hostile → Distrustful → Wary → Curious → Warming → Friendly → Trusted → Devoted)
- **Quests** — active / completed / failed, with objective + progress
- **Scene** — region, location and time of day

## Install

Copy this folder to either:

- `SillyTavern/data/<your-user>/extensions/old-gregs-tavern` (per user), or
- `SillyTavern/public/scripts/extensions/third-party/old-gregs-tavern` (all users)

Restart/refresh SillyTavern. The panel opens on the left; the beer-mug button reopens it if hidden.

## How it works

Each turn the extension injects the current state plus rules into the prompt. The model ends
its reply with a hidden `<!--OGT:{...}-->` comment (only changed values). The extension parses it,
removes it from the message, applies it, and stores a snapshot on the message — so swipes,
regenerates and deletes roll the tracker back correctly.

Everything is hand-editable in the panel. The **Game Master** tab has toggles, injection depth,
extra rules, a "scan story for missed updates" button, and a reset.

## Notes

- Works best with models that follow format instructions reliably. If a model forgets the tag,
  use "Scan story for missed updates".
- Tracker state lives in chat metadata (`chatMetadata.ogt`); settings in `extension_settings.old_gregs_tavern`.
- Not tested against every ST version — it uses `SillyTavern.getContext()` (1.12+).
