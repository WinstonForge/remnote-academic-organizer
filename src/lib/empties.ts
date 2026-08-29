import type { Rem, RNPlugin } from '@remnote/plugin-sdk';

export interface EmptyReport {
  examined: number;
  deleted: number;
  skipped: Record<string, number>;
  sampleDeleted: string[];
}

/**
 * Delete rems that are genuinely empty.
 *
 * "No text and no children" is not a safe test on its own. A rem can carry
 * meaning with an empty front: a flashcard whose answer lives in backText, a
 * property slot, a rem holding only an image, or something another rem points
 * at. Each of those is checked and skipped, and the counts are reported so the
 * skips are visible rather than assumed.
 *
 * Removals go to the trash and stay recoverable.
 */
export async function deleteEmptyRems(plugin: RNPlugin): Promise<EmptyReport> {
  const report: EmptyReport = {
    examined: 0,
    deleted: 0,
    skipped: {},
    sampleDeleted: [],
  };
  const skip = (why: string) => {
    report.skipped[why] = (report.skipped[why] ?? 0) + 1;
  };

  const str = async (rt: any): Promise<string> => {
    if (!rt) return '';
    try {
      return ((await plugin.richText.toString(rt)) ?? '').trim();
    } catch {
      return '';
    }
  };

  const all = await plugin.rem.getAll();

  // Find candidates first, then delete. Deleting while walking getAll() would
  // act on a list that is going stale underneath.
  const candidates: Rem[] = [];
  for (let i = 0; i < all.length; i += 60) {
    const batch = await Promise.all(
      all.slice(i, i + 60).map(async (rem) => {
        const front = await str(rem.text);
        if (front) return null;
        const kids = await rem.getChildrenRem().catch(() => [] as Rem[]);
        if (kids.length) return null;
        return rem;
      }),
    );
    candidates.push(...batch.filter((r): r is Rem => r !== null));
  }
  report.examined = candidates.length;

  for (const rem of candidates) {
    // An empty front with a filled back is a real card, not an empty rem.
    if (await str(rem.backText)) {
      skip('has backText (a card)');
      continue;
    }
    // Rich text can hold an image or latex that stringifies to nothing.
    const raw = (rem.text as any[]) ?? [];
    if (Array.isArray(raw) && raw.some((el) => el && typeof el === 'object')) {
      skip('holds a non-text element (image/latex/reference)');
      continue;
    }
    if (await rem.isDocument().catch(() => false)) {
      skip('is a document');
      continue;
    }
    if (await rem.isSlot().catch(() => false)) {
      skip('is a property slot');
      continue;
    }
    if ((await rem.getTagRems().catch(() => [] as Rem[])).length) {
      skip('is tagged');
      continue;
    }
    if ((await rem.remsReferencingThis().catch(() => [] as Rem[])).length) {
      skip('something references it');
      continue;
    }
    if ((await rem.taggedRem().catch(() => [] as Rem[])).length) {
      skip('is used as a tag');
      continue;
    }

    const id = rem._id;
    await rem.remove().catch(() => undefined);
    if (!(await plugin.rem.findOne(id))) {
      report.deleted++;
      if (report.sampleDeleted.length < 10) report.sampleDeleted.push(id);
    } else {
      skip('remove did not take');
    }
  }

  return report;
}
