import type { RNPlugin, Rem } from '@remnote/plugin-sdk';

/**
 * Writes a live card count into each chapter of a study workspace.
 *
 * A widget would keep itself current, but registering one at
 * WidgetLocation.Pane stopped this plugin activating at all, so the count is
 * written into the chapter as a normal line and refreshed by re-running the
 * command. The line is rewritten in place, never duplicated.
 */

const WORKSPACE = '6PaT91fCGNJOJsmSA'; // Fall 2026 Retake Working Workspace
const PREFIX = 'Cards :';

async function plain(plugin: RNPlugin, rt: any): Promise<string> {
  if (!rt) return '';
  return ((await plugin.richText.toString(rt).catch(() => '')) ?? '').trim();
}

type Counts = { total: number; cloze: number; qa: number };

/** Cards on this rem and everything beneath it, split by kind. */
async function countCards(chapter: Rem): Promise<Counts> {
  const rems: Rem[] = [chapter, ...(await chapter.getDescendants().catch(() => [] as Rem[]))];
  let total = 0;
  let cloze = 0;
  for (const rem of rems) {
    const cards = await rem.getCards().catch(() => []);
    for (const card of cards) {
      total++;
      // A cloze card's type carries the cloze id; forward/backward are strings.
      if (card.type && typeof card.type === 'object') cloze++;
    }
  }
  return { total, cloze, qa: total - cloze };
}

function line(c: Counts): string {
  if (c.total === 0) return `${PREFIX} none yet`;
  const parts = [`${c.total} total`];
  if (c.qa) parts.push(`${c.qa} question and answer`);
  if (c.cloze) parts.push(`${c.cloze} cloze`);
  return `${PREFIX} ${parts.join(', ')}`;
}

export async function updateChapterCardCounts(plugin: RNPlugin): Promise<string> {
  const workspace = await plugin.rem.findOne(WORKSPACE);
  if (!workspace) return 'workspace missing';

  let written = 0;
  let grand = 0;
  let grandCloze = 0;

  for (const chapter of await workspace.getChildrenRem()) {
    const title = await plain(plugin, chapter.text);
    if (!/^(Chapter|Appendix)\b/i.test(title)) continue;

    const counts = await countCards(chapter);
    grand += counts.total;
    grandCloze += counts.cloze;
    const text = line(counts);

    // Rewrite the existing count line if there is one, so re-running is safe.
    let slot: Rem | undefined;
    for (const child of await chapter.getChildrenRem()) {
      if ((await plain(plugin, child.text)).startsWith(PREFIX)) { slot = child; break; }
    }
    if (slot) {
      await slot.setText([text]);
    } else {
      const rem = await plugin.rem.createRem();
      if (!rem) continue;
      await rem.setText([text]);
      await rem.setParent(chapter, 0);
    }
    written++;
  }

  // Same treatment for the workspace itself, so the total is visible at the top.
  const summary = `${PREFIX} ${grand} total across ${written} chapters, ${grandCloze} cloze`;
  let top: Rem | undefined;
  for (const child of await workspace.getChildrenRem()) {
    if ((await plain(plugin, child.text)).startsWith(PREFIX)) { top = child; break; }
  }
  if (top) {
    await top.setText([summary]);
  } else {
    const rem = await plugin.rem.createRem();
    if (rem) { await rem.setText([summary]); await rem.setParent(workspace, 0); }
  }

  return `${written} chapters counted, ${grand} cards (${grandCloze} cloze)`;
}
