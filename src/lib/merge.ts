import type { Rem, RNPlugin } from '@remnote/plugin-sdk';
import { runAudit } from './audit';

export interface MergeReport {
  sets: number;
  merged: number;
  childrenMoved: number;
  copiesRemoved: number;
  skipped: string[];
  detail: string[];
}

/**
 * Merge duplicate sets that share a parent but whose contents differ.
 *
 * A blind delete would lose whatever the losing copy held that the survivor
 * did not. So this moves every child the survivor is missing into the survivor
 * first, and only removes a copy once it is empty. Nothing unique is discarded.
 *
 * Sets whose copies live under different parents are never touched - those are
 * legitimate repeats (a heading that recurs per chapter, or a genuine retake).
 */
export async function mergeDuplicates(plugin: RNPlugin): Promise<MergeReport> {
  const report: MergeReport = {
    sets: 0,
    merged: 0,
    childrenMoved: 0,
    copiesRemoved: 0,
    skipped: [],
    detail: [],
  };

  const text = async (r: Rem): Promise<string> => {
    try {
      return ((await plugin.richText.toString(r.text ?? [])) ?? '').trim();
    } catch {
      return '';
    }
  };

  const audit = await runAudit(plugin);
  const targets = audit.findings.filter(
    (f) => f.kind === 'duplicate' && f.sameParent && !f.identicalContent,
  );
  report.sets = targets.length;

  for (const f of targets) {
    const survivor = await plugin.rem.findOne(f.remId);
    if (!survivor) {
      report.skipped.push(`${f.current}: survivor missing`);
      continue;
    }

    const have = new Set<string>();
    for (const c of await survivor.getChildrenRem()) have.add(await text(c));

    let movedHere = 0;
    let removedHere = 0;

    for (const id of f.related ?? []) {
      const copy = await plugin.rem.findOne(id);
      if (!copy) continue;

      // Something pointing at the copy itself would be orphaned by removal.
      const refs = await copy.remsReferencingThis().catch(() => [] as Rem[]);
      if (refs.length > 0) {
        report.skipped.push(`${f.current}: a copy has ${refs.length} inbound reference(s)`);
        continue;
      }

      for (const child of await copy.getChildrenRem()) {
        const t = await text(child);
        if (have.has(t)) continue; // survivor already has it
        await child.setParent(survivor);
        have.add(t);
        movedHere++;
      }

      // Only remove once it holds nothing of its own.
      const left = await copy.getChildrenRem();
      if (left.length > 0) {
        report.skipped.push(`${f.current}: a copy still holds ${left.length} child(ren) - kept`);
        continue;
      }
      await copy.remove().catch(() => undefined);
      if (!(await plugin.rem.findOne(id))) removedHere++;
      else report.skipped.push(`${f.current}: remove did not take`);
    }

    if (movedHere || removedHere) {
      report.merged++;
      report.childrenMoved += movedHere;
      report.copiesRemoved += removedHere;
      report.detail.push(`${f.current}: moved ${movedHere} child(ren), removed ${removedHere} copy/copies`);
    }
  }

  return report;
}
