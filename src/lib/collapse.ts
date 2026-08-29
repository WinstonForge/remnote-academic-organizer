import type { Rem, RNPlugin } from '@remnote/plugin-sdk';
import { runAudit, type Finding } from './audit';

export interface CollapseReport {
  candidates: number;
  collapsed: number;
  removedIds: string[];
  kept: string[];
  skipped: string[];
}

/**
 * Collapse only the duplicate sets that are provably safe.
 *
 * "Safe" means both conditions hold:
 *   - every copy hangs off the same parent REM (compared by id, never by name -
 *     each semester block here is named "Course", so names collide and make
 *     genuine retakes look like duplicates), and
 *   - every copy's entire subtree fingerprints identically, so no copy holds
 *     anything the survivor does not.
 *
 * The largest copy survives. The rest go to RemNote's trash, which is
 * recoverable, and every removed id is reported so the change is auditable.
 */
export async function collapseSafeDuplicates(plugin: RNPlugin): Promise<CollapseReport> {
  const report: CollapseReport = {
    candidates: 0,
    collapsed: 0,
    removedIds: [],
    kept: [],
    skipped: [],
  };

  const audit = await runAudit(plugin);
  const dups = audit.findings.filter((f) => f.kind === 'duplicate');
  const safe = dups.filter((f) => f.sameParent && f.identicalContent);
  report.candidates = safe.length;

  for (const f of safe) {
    const survivor = await plugin.rem.findOne(f.remId);
    if (!survivor) {
      report.skipped.push(`${f.current}: survivor missing`);
      continue;
    }

    let removedHere = 0;
    for (const id of f.related ?? []) {
      const copy = await plugin.rem.findOne(id);
      if (!copy) continue;

      // Never remove a copy that something else points at - that would break a
      // reference the survivor cannot answer for.
      const refs = await copy.remsReferencingThis().catch(() => [] as Rem[]);
      if (refs.length > 0) {
        report.skipped.push(`${f.current}: a copy has ${refs.length} inbound reference(s)`);
        continue;
      }

      await copy.remove().catch(() => undefined);
      // Confirm it actually went, rather than assuming.
      if (!(await plugin.rem.findOne(id))) {
        report.removedIds.push(id);
        removedHere++;
      } else {
        report.skipped.push(`${f.current}: remove did not take`);
      }
    }

    if (removedHere > 0) {
      report.collapsed++;
      report.kept.push(`${f.current} (kept 1, removed ${removedHere})`);
    }
  }

  return report;
}

/** Remove a tag rem by name. MCP cannot delete tags; the plugin can. */
export async function removeTagByName(plugin: RNPlugin, name: string): Promise<string> {
  const rt = await plugin.richText.text(name).value();
  const tag = await plugin.rem.findByName(rt, null);
  if (!tag) return `No tag named "${name}" found.`;
  const tagged = await tag.taggedRem().catch(() => [] as Rem[]);
  if (tagged.length > 0) {
    return `"${name}" is still applied to ${tagged.length} rem(s) - left alone.`;
  }
  await tag.remove();
  return (await plugin.rem.findOne(tag._id))
    ? `Could not remove "${name}".`
    : `Removed the unused tag "${name}".`;
}
