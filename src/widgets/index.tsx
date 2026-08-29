import { declareIndexPlugin, type ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';
import { applyCourseTag, applyTitleFix, deleteReport, ensureCourseTag, repairRefSpacing, runAudit, writeReport } from '../lib/audit';
import { collapseSafeDuplicates, deleteExtraCopies, removeTagByName } from '../lib/collapse';
import { mergeDuplicates } from '../lib/merge';
import { deleteEmptyRems } from '../lib/empties';

async function onActivate(plugin: ReactRNPlugin) {
  await plugin.app.registerWidget('organizer', WidgetLocation.RightSidebar, {
    dimensions: { height: 'auto', width: '100%' },
    widgetTabTitle: 'Organizer',
  });

  // Scan and write the findings into a document, then open it.
  // A toast disappears; a document can be re-read and compared against the next run.
  await plugin.app.registerCommand({
    id: 'academic-organizer-scan',
    name: 'Academic Organizer: scan and write report',
    action: async () => {
      try {
        await plugin.app.toast('Clearing previous report…');
        // Must happen before the scan, or the report audits itself.
        await deleteReport(plugin);
        await plugin.app.toast('Scanning knowledge base…');
        const r = await runAudit(plugin, (done, total) => {
          void plugin.app.toast(`Scanning ${done} / ${total}…`);
        });
        const doc = await writeReport(plugin, r);
        await plugin.app.toast(
          `Done: ${r.scanned} rems, ${r.findings.length} findings. Opening report.`,
        );
        if (doc) await plugin.window.openRem(doc);
      } catch (e) {
        await plugin.app.toast(`Organizer failed: ${String(e)}`);
      }
    },
  });

  // Apply only the title fixes. Duplicates and orphans are never touched here.
  await plugin.app.registerCommand({
    id: 'academic-organizer-apply-titles',
    name: 'Academic Organizer: apply title fixes',
    action: async () => {
      try {
        await deleteReport(plugin); // keep the report out of its own scan
        await plugin.app.toast('Scanning before applying…');
        const r = await runAudit(plugin);
        const items = r.findings.filter((f) => f.kind === 'title');
        if (!items.length) {
          await plugin.app.toast('No title fixes to apply.');
          return;
        }

        let ok = 0;
        let skipped = 0;
        // Batches of 20: a single wide Promise.all saturates the plugin bridge
        // and writes start failing silently.
        for (let i = 0; i < items.length; i += 20) {
          const results = await Promise.all(
            items.slice(i, i + 20).map((f) =>
              applyTitleFix(plugin, f).catch(() => false),
            ),
          );
          for (const good of results) good ? ok++ : skipped++;
          await plugin.app.toast(`Applying ${Math.min(i + 20, items.length)} / ${items.length}…`);
        }

        await plugin.app.toast(`Applied ${ok}, skipped ${skipped}. Re-scanning…`);
        const after = await runAudit(plugin);
        const doc = await writeReport(plugin, after);
        await plugin.app.toast(
          `Done. ${ok} renamed. Remaining title findings: ${
            after.findings.filter((f) => f.kind === 'title').length
          }`,
        );
        if (doc) await plugin.window.openRem(doc);
      } catch (e) {
        await plugin.app.toast(`Apply failed: ${String(e)}`);
      }
    },
  });

  await plugin.app.registerCommand({
    id: 'academic-organizer-repair-ref-spacing',
    name: 'Academic Organizer: repair spacing after references',
    action: async () => {
      try {
        await plugin.app.toast('Repairing reference spacing…');
        const n = await repairRefSpacing(plugin);
        await plugin.app.toast(`Restored a space in ${n} rem${n === 1 ? '' : 's'}.`);
      } catch (e) {
        await plugin.app.toast(`Repair failed: ${String(e)}`);
      }
    },
  });


  await plugin.app.registerCommand({
    id: 'academic-organizer-collapse-duplicates',
    name: 'Academic Organizer: collapse safe duplicates',
    action: async () => {
      try {
        await deleteReport(plugin);
        await plugin.app.toast('Finding provably safe duplicate sets...');
        const r = await collapseSafeDuplicates(plugin);
        await plugin.app.toast(
          `Sets collapsed: ${r.collapsed} of ${r.candidates}. Rems trashed: ${r.removedIds.length}. Skipped: ${r.skipped.length}.`,
        );
        console.log('[collapse]', JSON.stringify(r, null, 2));
      } catch (e) {
        await plugin.app.toast(`Collapse failed: ${String(e)}`);
      }
    },
  });

  await plugin.app.registerCommand({
    id: 'academic-organizer-remove-test-tag',
    name: 'Academic Organizer: remove leftover TestTagFromClaude tag',
    action: async () => {
      try {
        await plugin.app.toast(await removeTagByName(plugin, 'TestTagFromClaude'));
      } catch (e) {
        await plugin.app.toast(`Tag removal failed: ${String(e)}`);
      }
    },
  });



  await plugin.app.registerCommand({
    id: 'academic-organizer-merge-duplicates',
    name: 'Academic Organizer: merge differing duplicates',
    action: async () => {
      try {
        await deleteReport(plugin);
        await plugin.app.toast('Merging duplicate sets that share a parent...');
        const r = await mergeDuplicates(plugin);
        await plugin.app.toast(
          `Merged ${r.merged}/${r.sets} sets. Moved ${r.childrenMoved} children, removed ${r.copiesRemoved} copies, skipped ${r.skipped.length}.`,
        );
        console.log('[merge]', JSON.stringify(r, null, 2));
      } catch (e) {
        await plugin.app.toast(`Merge failed: ${String(e)}`);
      }
    },
  });

  await plugin.app.registerCommand({
    id: 'academic-organizer-delete-extra-copies',
    name: 'Academic Organizer: delete extra duplicate copies',
    action: async () => {
      try {
        await deleteReport(plugin);
        await plugin.app.toast('Deleting extra copies of same-parent duplicates...');
        const r = await deleteExtraCopies(plugin);
        await plugin.app.toast(
          `Sets: ${r.collapsed}/${r.candidates}. Trashed ${r.removedIds.length} copies. Unique lines lost: ${r.lost.length}. Skipped: ${r.skipped.length}.`,
        );
        console.log('[delete-extra]', JSON.stringify(r, null, 2));
      } catch (e) {
        await plugin.app.toast(`Delete failed: ${String(e)}`);
      }
    },
  });

  await plugin.app.registerCommand({
    id: 'academic-organizer-delete-empties',
    name: 'Academic Organizer: delete empty rems',
    action: async () => {
      try {
        await deleteReport(plugin);
        await plugin.app.toast('Finding genuinely empty rems...');
        const r = await deleteEmptyRems(plugin);
        const skips = Object.entries(r.skipped).map(([k, n]) => `${n} ${k}`).join(', ');
        await plugin.app.toast(
          `Deleted ${r.deleted} of ${r.examined} candidates.${skips ? ' Kept: ' + skips + '.' : ''}`,
        );
        console.log('[empties]', JSON.stringify(r, null, 2));
      } catch (e) {
        await plugin.app.toast(`Delete empties failed: ${String(e)}`);
      }
    },
  });

  await plugin.app.registerCommand({
    id: 'academic-organizer-tag-courses',
    name: 'Academic Organizer: tag untagged course codes',
    action: async () => {
      try {
        await deleteReport(plugin);
        await plugin.app.toast('Finding course codes without a course tag...');
        const audit = await runAudit(plugin);
        const items = audit.findings.filter((f) => f.kind === 'course');
        if (!items.length) {
          await plugin.app.toast('No untagged course codes found.');
          return;
        }
        // Reuses the knowledge base's own tag ("Classes" where it exists)
        // rather than minting a parallel one.
        const tag = await ensureCourseTag(plugin);
        if (!tag) {
          await plugin.app.toast('Could not resolve a course tag - nothing applied.');
          return;
        }
        const tagName = (await plugin.richText.toString(tag.text ?? [])) ?? '?';
        let ok = 0;
        let failed = 0;
        for (const f of items) {
          (await applyCourseTag(plugin, f, tag)) ? ok++ : failed++;
        }
        await plugin.app.toast(`Tagged ${ok} course code(s) with "${tagName}". Failed: ${failed}.`);
        console.log('[tag-courses]', { tagName, ok, failed, items: items.map((i) => i.current) });
      } catch (e) {
        await plugin.app.toast(`Tagging failed: ${String(e)}`);
      }
    },
  });















}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
