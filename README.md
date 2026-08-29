# Academic Organizer

A RemNote plugin that audits a knowledge base for structural damage and applies
only the fixes you explicitly approve.

Built to do the things the RemNote Desktop MCP server cannot: rename rems, move
them between parents, read tags, and create portals.

## What it finds

| Finding | Applied automatically? |
| --- | --- |
| **Damaged titles** — leaked `**markdown**`, doubled spaces, trailing colons | Yes, on Apply |
| **Untagged courses** — course codes (`ACCT 2101`) with no course tag | Yes, on Apply |
| **Duplicate documents** — same title, grouped with the largest copy first | No, reported only |
| **Orphans & unnamed** — empty rems, and titles like `##` or `3` holding real children | No, reported only |

Duplicates and orphans are deliberately report-only. Choosing which copy of a
document is canonical, or what an untitled rem should be called, is a judgement
call — the plugin surfaces them and leaves the decision to you.

## Safety model

- Nothing is written until you press **Apply**. Scanning is read-only.
- Title fixes re-read each rem at apply time and re-derive the change, so a rem
  edited between scan and apply is skipped rather than clobbered.
- Only cosmetic damage is repaired. The plugin never rewrites meaning, never
  deletes, and never merges.
- All course tags point at a single shared `Course` rem rather than creating one
  per semester.

## Running it

```bash
npm install
npm run dev
```

Then in RemNote: **Settings → Plugins → Build → Develop from localhost →
`http://localhost:8080`**. The panel appears as **Organizer** in the right sidebar.

There is also an omnibar command, *Academic Organizer: scan knowledge base*,
which reports counts as a toast without opening the panel.

If a plugin ever breaks RemNote, open `https://www.remnote.com/notes?disablePlugins`.

## Scopes

Declared as `All / ReadCreateModifyDelete` in `public/manifest.json`. Renaming and
moving rems is not possible at a lower level.

## Layout

- `src/lib/audit.ts` — scan and fix engine, no UI
- `src/widgets/organizer.tsx` — the sidebar panel
- `src/widgets/index.tsx` — activation, widget and command registration
