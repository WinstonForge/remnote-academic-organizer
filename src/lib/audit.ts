import type { Rem, RNPlugin } from '@remnote/plugin-sdk';

export type FindingKind = 'title' | 'orphan' | 'duplicate' | 'course';

export interface Finding {
  kind: FindingKind;
  remId: string;
  current: string;
  /** Only present when the finding can be applied automatically. */
  proposed?: string;
  detail?: string;
  /** Sibling rem ids, e.g. the other copies in a duplicate set. */
  related?: string[];
  /** Ancestor path of each copy, used to tell real duplicates from repeated headings. */
  paths?: string[];
  /** True when every copy sits under the same parent REM (compared by id, not name). */
  sameParent?: boolean;
  /** True when every copy's subtree contains exactly the same text. */
  identicalContent?: boolean;
}

export interface AuditResult {
  scanned: number;
  documents: number;
  findings: Finding[];
  ranAt: string;
}

/** Course codes like "ACCT 2101", "BIOL 1103L", "CS 2110". */
const COURSE_CODE = /^[A-Z]{2,4}\s?\d{4}[A-Z]?$/;

/**
 * Titles carrying no meaning on their own.
 *
 * Deliberately excludes bare numbers. A rem titled "7" with children is almost
 * always a numbered list item or a table row, and flagging those buries the
 * real findings under hundreds of false positives.
 */
const MEANINGLESS = /^(#{1,6}|[-–—*_.:;,]+)$/;

/**
 * Derive a cleaned title, or null when the text is already fine.
 * Only cosmetic damage is repaired here - never meaning.
 */
export function proposeTitle(raw: string): string | null {
  let s = raw;

  // Wrapping bold/italic markers that leaked in from a paste.
  let changed = true;
  while (changed) {
    changed = false;
    const m = s.match(/^\s*(\*\*|__|\*|_)([\s\S]+?)\1\s*$/);
    if (m && m[2].trim()) {
      s = m[2];
      changed = true;
    }
  }

  // Collapse internal runs of whitespace and trim the ends.
  s = s.replace(/[ \t]+/g, ' ').trim();

  // A trailing colon left over from a heading paste.
  s = s.replace(/\s*:$/, '');

  if (!s || s === raw) return null;
  return s;
}

/** Name the reason a title changed, so a reviewer can judge it at a glance. */
export function describeChange(before: string, after: string): string {
  const reasons: string[] = [];
  if (before !== before.trim()) reasons.push('outer whitespace');
  if (/[ \t]{2,}/.test(before)) reasons.push('doubled spaces');
  if (/^\s*(\*\*|__|\*|_)[\s\S]+\1\s*$/.test(before)) reasons.push('wrapping markers');
  if (/\s*:$/.test(before) && !/\s*:$/.test(after)) reasons.push('trailing colon');
  return reasons.length ? reasons.join(' + ') : 'other';
}

async function plainText(plugin: RNPlugin, rem: Rem): Promise<string> {
  try {
    if (!rem.text) return '';
    return (await plugin.richText.toString(rem.text)) ?? '';
  } catch {
    return '';
  }
}

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

interface Row {
  rem: Rem;
  text: string;
  isDoc: boolean;
  childCount: number;
}

/** Every SDK call crosses an iframe bridge, so batch them or a large KB crawls. */
async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

export async function runAudit(
  plugin: RNPlugin,
  onProgress?: (done: number, total: number) => void,
): Promise<AuditResult> {
  const all = await plugin.rem.getAll();
  const findings: Finding[] = [];

  let done = 0;
  const rows: Row[] = await inBatches(all, 60, async (rem) => {
    const [text, isDoc, children] = await Promise.all([
      plainText(plugin, rem),
      rem.isDocument().catch(() => false),
      rem.getChildrenRem().catch(() => [] as Rem[]),
    ]);
    done++;
    if (onProgress && done % 120 === 0) onProgress(done, all.length);
    return { rem, text, isDoc, childCount: children.length };
  });

  // Only course-code-shaped rems need their tags read.
  const candidates = rows.filter((r) => COURSE_CODE.test(r.text.trim()));
  const courseTagged = new Set<string>();
  await inBatches(candidates, 40, async (row) => {
    try {
      const tags = await row.rem.getTagRems();
      const names = await Promise.all(tags.map((t) => plainText(plugin, t)));
      // Match on substring, not exact equality. A knowledge base may name its
      // course tag "Classes", "Course", or something more specific such as
      // "Course Code (Degree Map)"; an exact match reports all of the latter
      // as untagged forever.
      if (names.some((n) => {
        const s = n.trim().toLowerCase();
        return s.includes('course') || s.includes('class');
      })) {
        courseTagged.add(row.rem._id);
      }
    } catch {
      /* tag read failure is not fatal to the audit */
    }
  });

  const byNormalized = new Map<string, typeof rows>();

  for (const row of rows) {
    const { rem, text, isDoc, childCount } = row;

    // 1. Damaged titles - cosmetic only, always reversible.
    const proposed = proposeTitle(text);
    if (proposed) {
      findings.push({
        kind: 'title',
        remId: rem._id,
        current: text,
        proposed,
        detail: isDoc ? 'document' : 'rem',
      });
    }

    // 2. Meaningless titles carrying real content - reported, never auto-renamed.
    if (MEANINGLESS.test(text.trim()) && childCount > 0) {
      findings.push({
        kind: 'orphan',
        remId: rem._id,
        current: text || '[empty]',
        detail: `uninterpretable title holding ${childCount} children - needs a human name`,
      });
    }

    // 3. Empty rems with nothing under them.
    if (!text.trim() && childCount === 0) {
      findings.push({
        kind: 'orphan',
        remId: rem._id,
        current: '[empty]',
        detail: 'empty rem with no children',
      });
    }

    // 4. Course codes missing the Course tag.
    if (COURSE_CODE.test(text.trim()) && !courseTagged.has(rem._id)) {
      findings.push({
        kind: 'course',
        remId: rem._id,
        current: text.trim(),
        proposed: 'Course',
        detail: 'course code without a #Course tag',
      });
    }

    // Collect duplicate candidates. Documents are not the only things that get
    // duplicated - re-imported course material is usually plain rems with children.
    if (text.trim() && (isDoc || childCount >= 3)) {
      const key = normalizeForCompare(text);
      if (!key || key.length < 8) continue;
      const bucket = byNormalized.get(key);
      if (bucket) bucket.push(row);
      else byNormalized.set(key, [row]);
    }
  }

  // Ancestor path for a rem, nearest parent first. Only used on duplicate
  // candidates, so the parent walk stays cheap.
  const pathOf = async (rem: Rem): Promise<string> => {
    const parts: string[] = [];
    let cur: Rem | undefined = rem;
    for (let i = 0; i < 4; i++) {
      cur = await cur.getParentRem().catch(() => undefined);
      if (!cur) break;
      const t = (await plainText(plugin, cur)).trim();
      parts.push(t || '[untitled]');
    }
    return parts.length ? parts.reverse().join(' > ') : '[top level]';
  };

  /**
   * Compare by parent REM ID, never by parent name.
   *
   * Every semester block in this degree map is literally named "Course", so a
   * name-based path makes ACCT 2102, ENGL 1102 and ECON 2105 look like they
   * share a parent when they are in fact separate semesters - i.e. retakes,
   * not duplicates.
   */
  const parentIdOf = async (rem: Rem): Promise<string> => {
    const p = await rem.getParentRem().catch(() => undefined);
    return p?._id ?? '[root]';
  };

  /** Fingerprint a rem's whole subtree, so "identical" means identical. */
  const fingerprint = async (rem: Rem, depth = 0): Promise<string> => {
    const own = (await plainText(plugin, rem)).trim();
    const back = rem.backText ? (await plainText(plugin, rem.backText as any)).trim() : '';
    if (depth >= 3) return `${own}|${back}`;
    const kids = await rem.getChildrenRem().catch(() => [] as Rem[]);
    const kidPrints = await Promise.all(kids.map((k) => fingerprint(k, depth + 1)));
    return `${own}|${back}[${kidPrints.sort().join(';')}]`;
  };

  // 5. Duplicates - reported with all copies, never merged automatically.
  // A title repeated dozens of times is a recurring daily-note item (a habit
  // tracker, a timer, a template line), not a duplicate anyone wants collapsed.
  const RECURRING_THRESHOLD = 20;
  for (const [, bucket] of byNormalized) {
    if (bucket.length < 2 || bucket.length > RECURRING_THRESHOLD) continue;
    const sorted = [...bucket].sort((a, b) => b.childCount - a.childCount);
    const canonical = sorted[0];
    const paths = await Promise.all(sorted.map((r) => pathOf(r.rem)));
    const parentIds = await Promise.all(sorted.map((r) => parentIdOf(r.rem)));
    const sameParent = new Set(parentIds).size === 1;

    const prints = await Promise.all(sorted.map((r) => fingerprint(r.rem)));
    const identicalContent = new Set(prints).size === 1;

    // Only a set that shares a parent AND is byte-identical is safe to act on
    // without a human choosing which copy survives.
    const verdict = !sameParent
      ? 'DIFFERENT PARENTS - leave alone'
      : identicalContent
        ? 'SAME PARENT + IDENTICAL CONTENT - safe to collapse'
        : 'SAME PARENT but CONTENT DIFFERS - needs a human merge';

    findings.push({
      kind: 'duplicate',
      remId: canonical.rem._id,
      current: canonical.text,
      detail: `${bucket.length} copies, largest has ${canonical.childCount} children :: ${verdict}`,
      related: sorted.slice(1).map((r) => r.rem._id),
      paths,
      sameParent,
      identicalContent,
    });
  }

  return {
    scanned: rows.length,
    documents: rows.filter((r) => r.isDoc).length,
    findings,
    ranAt: new Date().toISOString(),
  };
}

/**
 * Clean a rem's rich text in place, preserving every non-text element.
 *
 * A rem's text is an array that can hold rem references, images, latex and
 * formatted spans alongside plain strings. Writing back a flat
 * `setText(['plain string'])` would silently destroy all of that - several of
 * these rems carry live document references. So only the string parts are
 * touched; everything else passes through untouched.
 *
 * Returns null when nothing would change.
 */
export function cleanRichText(text: any[]): any[] | null {
  if (!Array.isArray(text) || text.length === 0) return null;

  const readable = (el: any): string | null => {
    if (typeof el === 'string') return el;
    if (el && typeof el === 'object' && typeof el.text === 'string') return el.text;
    return null; // reference, image, latex, delimiter - never rewritten
  };
  const write = (el: any, s: string): any =>
    typeof el === 'string' ? s : { ...el, text: s };

  const out = text.map((el) => {
    const s = readable(el);
    // Collapse runs of spaces/tabs inside text, leaving other elements alone.
    return s === null ? el : write(el, s.replace(/[ \t]{2,}/g, ' '));
  });

  // Trim only at the true edges of the rem.
  //
  // Trimming the first *text-bearing* element is wrong when something else comes
  // first: in "[[Some Doc]] — Online" the text part is " — Online", and trimming
  // its leading space closes the gap after the reference. Only trim when the text
  // element really is at index 0 (or the final index).
  const firstIdx = 0;
  const lastIdx = out.length - 1;
  if (readable(out[firstIdx]) !== null) {
    out[firstIdx] = write(out[firstIdx], readable(out[firstIdx])!.replace(/^\s+/, ''));
  }
  if (readable(out[lastIdx]) !== null) {
    let tail = readable(out[lastIdx])!.replace(/\s+$/, '');
    tail = tail.replace(/\s*:$/, ''); // trailing colon left from a heading paste
    out[lastIdx] = write(out[lastIdx], tail);
  }

  // Drop any element that has been emptied, unless that would empty the rem.
  const pruned = out.filter((el) => {
    const s = readable(el);
    return s === null || s.length > 0;
  });
  const final = pruned.length ? pruned : out;

  return JSON.stringify(final) === JSON.stringify(text) ? null : final;
}

/**
 * Repair pass for one specific regression.
 *
 * An earlier version of cleanRichText trimmed the first *text-bearing* element
 * rather than the first element, which closed the gap in "[[Some Doc]] — Online",
 * producing "[[Some Doc]]— Online". This restores a single space where a text
 * element directly follows a non-text element and opens with a dash.
 *
 * Deliberately narrow: it only fires on a leading dash, where the missing space
 * is unambiguous.
 */
export async function repairRefSpacing(plugin: RNPlugin): Promise<number> {
  const all = await plugin.rem.getAll();
  let fixed = 0;
  for (let i = 0; i < all.length; i += 60) {
    const results = await Promise.all(
      all.slice(i, i + 60).map(async (rem) => {
        const text = rem.text as any[] | undefined;
        if (!Array.isArray(text) || text.length < 2) return false;
        let changed = false;
        const out = text.map((el, idx) => {
          if (idx === 0) return el;
          const prev = text[idx - 1];
          const prevIsText =
            typeof prev === 'string' || (prev && typeof prev.text === 'string');
          if (prevIsText) return el;
          const s =
            typeof el === 'string' ? el : el && typeof el.text === 'string' ? el.text : null;
          if (s === null || !/^[—–-]/.test(s)) return el;
          changed = true;
          return typeof el === 'string' ? ' ' + s : { ...el, text: ' ' + s };
        });
        if (!changed) return false;
        await rem.setText(out).catch(() => undefined);
        return true;
      }),
    );
    fixed += results.filter(Boolean).length;
  }
  return fixed;
}

/** Rename a single rem. Returns true when the write succeeded. */
export async function applyTitleFix(plugin: RNPlugin, f: Finding): Promise<boolean> {
  if (f.kind !== 'title') return false;
  const rem = await plugin.rem.findOne(f.remId);
  if (!rem || !rem.text) return false;
  // Re-derive from the live rem: it may have changed since the scan.
  const cleaned = cleanRichText(rem.text as any[]);
  if (!cleaned) return false;
  await rem.setText(cleaned);
  return true;
}

/**
 * Reuse the knowledge base's own course tag rather than inventing a parallel one.
 * Many RemNote setups already have a "Classes" tag carrying properties such as
 * Semester and Professor, so prefer that; fall back to "Course" if it is absent.
 */
export async function ensureCourseTag(plugin: RNPlugin): Promise<Rem | undefined> {
  // findByName(name, null) only searches the TOP LEVEL. A knowledge base whose
  // course tag lives under a parent (e.g. University > Classes) is missed
  // entirely, and the caller then creates a duplicate top-level tag - the exact
  // parallel-tag problem this function exists to avoid. Search all rems, and
  // prefer whichever candidate is already doing the most tagging.
  const all = await plugin.rem.getAll();
  const found: Record<string, { rem: Rem; uses: number }[]> = { classes: [], course: [] };

  for (let i = 0; i < all.length; i += 60) {
    await Promise.all(
      all.slice(i, i + 60).map(async (rem) => {
        const name = ((await plugin.richText.toString(rem.text ?? [])) ?? '').trim().toLowerCase();
        if (name !== 'classes' && name !== 'course') return;
        const uses = (await rem.taggedRem().catch(() => [] as Rem[])).length;
        found[name].push({ rem, uses });
      }),
    );
  }

  // Prefer by NAME, then by usage within that name. Ranking purely by usage
  // lets a freshly created tag outrank the knowledge base's real one as soon as
  // it has been applied a few times.
  for (const key of ['classes', 'course']) {
    const hits = found[key];
    if (!hits.length) continue;
    hits.sort((a, b) => b.uses - a.uses);
    return hits[0].rem;
  }

  const created = await plugin.rem.createRem();
  if (!created) return undefined;
  await created.setText(['Course']);
  return created;
}

/**
 * Repair: move rems off a stray course tag onto the knowledge base's real one,
 * then remove the stray if nothing else uses it.
 */
export async function consolidateCourseTag(
  plugin: RNPlugin,
  strayId: string,
): Promise<string> {
  const stray = await plugin.rem.findOne(strayId);
  if (!stray) return 'Stray tag not found - nothing to do.';
  const real = await ensureCourseTag(plugin);
  if (!real) return 'Could not resolve the real course tag.';
  if (real._id === strayId) return 'The stray IS the most-used tag - left alone.';

  const realName = ((await plugin.richText.toString(real.text ?? [])) ?? '').trim();
  const tagged = await stray.taggedRem().catch(() => [] as Rem[]);
  let moved = 0;
  for (const r of tagged) {
    await r.addTag(real).catch(() => undefined);
    await r.removeTag(strayId).catch(() => undefined);
    moved++;
  }
  const left = await stray.taggedRem().catch(() => [] as Rem[]);
  let removed = false;
  if (left.length === 0) {
    await stray.remove().catch(() => undefined);
    removed = !(await plugin.rem.findOne(strayId));
  }
  return `Moved ${moved} rem(s) onto "${realName}". Stray tag ${removed ? 'removed' : 'kept (still in use)'}.`;
}

/**
 * Write the audit into a real document. Toasts vanish; a document can be
 * re-read, shared, and diffed against the next run.
 */
export const REPORT_TITLE = 'Academic Organizer Report';

/**
 * Remove the previous report BEFORE scanning.
 *
 * Without this the scan reads its own output back in: the report's several
 * hundred lines become fresh "findings", which then get written into the next
 * report, and the counts climb every run. Deleting first is simpler and more
 * reliable than trying to exclude the subtree mid-scan.
 */
const REPORT_ID_KEY = 'academic-organizer:report-id';

export async function deleteReport(plugin: RNPlugin): Promise<void> {
  const targets: (Rem | undefined)[] = [];

  // By stored id first. Looking it up by name is not enough - if the title is
  // ever edited the old report survives, gets scanned, and inflates every
  // subsequent run's counts.
  const storedId = await plugin.storage.getSynced<string>(REPORT_ID_KEY);
  if (storedId) targets.push(await plugin.rem.findOne(storedId));

  const name = await plugin.richText.text(REPORT_TITLE).value();
  targets.push(await plugin.rem.findByName(name, null));

  const seen = new Set<string>();
  for (const doc of targets) {
    if (!doc || seen.has(doc._id)) continue;
    seen.add(doc._id);
    await removeSubtree(plugin, doc);
  }
  await plugin.storage.setSynced(REPORT_ID_KEY, undefined);
}

/**
 * Delete a report and everything under it, then confirm it is actually gone.
 *
 * A single Promise.all over ~500 removals saturates the plugin bridge: some
 * removals silently fail and the parent delete lands while children are still
 * settling, leaving a half-emptied document behind. Small sequential batches
 * plus a verify-and-retry is slower but actually deletes.
 */
async function removeSubtree(plugin: RNPlugin, doc: Rem): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const children = await doc.getChildrenRem().catch(() => [] as Rem[]);
    for (let i = 0; i < children.length; i += 20) {
      await Promise.all(
        children.slice(i, i + 20).map((c) => c.remove().catch(() => undefined)),
      );
    }
    await doc.remove().catch(() => undefined);
    if (!(await plugin.rem.findOne(doc._id))) return;
  }
}

export async function writeReport(plugin: RNPlugin, r: AuditResult): Promise<Rem | undefined> {
  const doc = await plugin.rem.createRem();
  if (!doc) return undefined;
  await doc.setText([REPORT_TITLE]);
  await doc.setIsDocument(true);
  // Remember the id so the next run can delete this report even if it is renamed.
  await plugin.storage.setSynced(REPORT_ID_KEY, doc._id);

  const section = async (label: string, parent: Rem) => {
    const s = await plugin.rem.createRem();
    if (!s) return undefined;
    await s.setText([label]);
    await s.setParent(parent);
    return s;
  };

  const header = await section(
    `Scanned ${r.scanned} rems / ${r.documents} documents at ${new Date(r.ranAt).toLocaleString()}`,
    doc,
  );
  if (!header) return doc;

  const kinds: FindingKind[] = ['title', 'course', 'duplicate', 'orphan'];
  const labels: Record<FindingKind, string> = {
    title: 'Damaged titles (fixable)',
    course: 'Untagged courses (fixable)',
    duplicate: 'Duplicate documents (review only)',
    orphan: 'Orphans and unnamed (review only)',
  };

  for (const kind of kinds) {
    const items = r.findings.filter((f) => f.kind === kind);
    const head = await section(`${labels[kind]} - ${items.length}`, doc);
    if (!head) continue;
    // Cap each section. A report that is itself 500 rems is hard to delete
    // reliably and hard to read; the full counts are in the section headers.
    for (const f of items.slice(0, 75)) {
      // Guillemets make trailing spaces and stripped markers visible. Without
      // them every whitespace fix renders as "X -> X" and cannot be reviewed.
      const line = f.proposed && f.kind === 'title'
        ? `«${f.current}» -> «${f.proposed}»   [${describeChange(f.current, f.proposed)}]`
        : f.detail
          ? `${f.current}  (${f.detail})`
          : f.current;
      const child = await plugin.rem.createRem();
      if (!child) continue;
      await child.setText([line]);
      await child.setParent(head);
      // For duplicates, list where each copy lives AND its rem id. The path
      // alone is not enough to act on - picking a survivor means opening the
      // specific copies and comparing them.
      // Duplicates only. Every other finding is a single rem, so emitting a
      // copy list for it just floods the report with "[path unknown]" lines.
      const ids = f.kind === 'duplicate' ? [f.remId, ...(f.related ?? [])] : [];
      const paths = f.paths ?? [];
      for (let i = 0; i < ids.length; i++) {
        const loc = await plugin.rem.createRem();
        if (!loc) continue;
        const tag = i === 0 ? 'largest' : `copy ${i + 1}`;
        await loc.setText([`[${tag}] ${ids[i]} :: ${paths[i] ?? '[path unknown]'}`]);
        await loc.setParent(child);
      }
    }
  }
  return doc;
}

export async function applyCourseTag(
  plugin: RNPlugin,
  f: Finding,
  tag: Rem,
): Promise<boolean> {
  if (f.kind !== 'course') return false;
  const rem = await plugin.rem.findOne(f.remId);
  if (!rem) return false;
  await rem.addTag(tag);
  return true;
}
