import type { RNPlugin, Rem } from '@remnote/plugin-sdk';

/**
 * Reads a class's coursework straight out of the Assignments / Exams / Lectures
 * tables and shapes it into a study map: each exam, the chapters it covers, and
 * for each chapter the lecture week, the homework due date and the cards.
 *
 * Nothing about a particular course is hard-coded. The only fixed ids are the
 * three tags themselves, and each is re-resolved by name if the id ever moves.
 */

const TAG = {
  assignment: { id: 'wOKq7Z86NrdDIdYUH', name: 'Assignments' },
  exam: { id: 'qgNGsAcVBQpsbqU9l', name: '🧠 Exams' },
  lecture: { id: 'wXNDAdeZIfN38xi47', name: '👩‍🏫 Lectures' },
};
const SLOT = {
  aDue: 'LyNeQgAshTuxu9ICc',
  aClass: 'YQGphJu5SQDb9WjbN',
  eDate: '1ytgRSZkon8g9TSEm',
  eTopics: 'pxHCIKZiRQVJvuZYX',
  eClass: 'qnmDwyg5FM7MkLemJ',
  lDate: 'uJwbvSDqRHtpZRpUp',
  lClass: 'QBA0nCTi9wMlNj2YA',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export type Chapter = {
  key: string;          // "14" or "Appendix B"
  label: string;        // chapter title from the lecture week, when known
  week?: string;        // "Week 1 (8.24 to 8.30)"
  dueISO?: string;      // homework due date
  dueLabel?: string;
  remId?: string;       // lecture rem, so a click can open it
  cards: number;
};

export type ExamNode = {
  name: string;
  cumulative?: boolean;
  dateISO?: string;
  dateLabel?: string;
  daysAway?: number;
  remId: string;
  chapters: Chapter[];
};

export type CourseMap = {
  className: string;
  classId: string;
  exams: ExamNode[];
  orphanChapters: Chapter[];   // chapters no exam claims
  generatedAt: number;
};

async function plain(plugin: RNPlugin, rt: any): Promise<string> {
  if (!rt) return '';
  return ((await plugin.richText.toString(rt).catch(() => '')) ?? '').trim();
}

/** Read one tag-property value off a row. Returns text plus any referenced id. */
async function slotOf(
  plugin: RNPlugin,
  row: Rem,
  slotId: string,
): Promise<{ text: string; refId?: string }> {
  for (const child of await row.getChildrenRem()) {
    const head = (child.text as any[]) ?? [];
    if (!head.some((el: any) => el && typeof el === 'object' && el._id === slotId)) continue;
    const back = (child.backText as any[]) ?? [];
    const ref = back.find((el: any) => el && typeof el === 'object' && el._id);
    return { text: await plain(plugin, back), refId: ref?._id };
  }
  return { text: '' };
}

/** "September 22nd, 2026" -> ISO "2026-09-22". */
function isoFromLongDate(text: string): string | undefined {
  const m = /([A-Z][a-z]+)\s+(\d{1,2})[a-z]{0,2},?\s*(\d{4})/.exec(text);
  if (!m) return undefined;
  const mi = MONTHS.indexOf(m[1]);
  if (mi < 0) return undefined;
  const mm = String(mi + 1).padStart(2, '0');
  const dd = String(Number(m[2])).padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

function daysFromToday(iso: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const then = new Date(`${iso}T00:00:00`);
  return Math.round((then.getTime() - today.getTime()) / 86400000);
}

/** "Chapters 22, 23, 24 and Appendix B : ..." -> ["22","23","24","Appendix B"] */
function chapterKeys(topics: string): string[] {
  // Chapters usually sit before the colon; a cumulative exam names them after
  // it ("Cumulative across the whole course : Chapters 14, 15 ...").
  let head = topics.split(':')[0] ?? topics;
  if (!/\d/.test(head)) head = topics;
  const keys: string[] = [];
  for (const m of head.matchAll(/\d{1,2}/g)) keys.push(m[0]);
  if (/appendix\s+([A-Z])/i.test(head)) {
    const a = /appendix\s+([A-Z])/i.exec(head);
    if (a) keys.push(`Appendix ${a[1].toUpperCase()}`);
  }
  return Array.from(new Set(keys));
}

/** Chapters a lecture week teaches, with the title it uses for them. */
function chaptersInLecture(label: string): Array<{ key: string; title: string }> {
  const out: Array<{ key: string; title: string }> = [];
  const body = label.includes(':') ? label.slice(label.indexOf(':') + 1) : label;
  for (const m of body.matchAll(/Chapter\s+(\d{1,2})([^,]*)/gi)) {
    out.push({ key: m[1], title: `Chapter ${m[1]}${(m[2] ?? '').replace(/\s+continued\s*$/i, '')}`.trim() });
  }
  for (const m of body.matchAll(/Appendix\s+([A-Z])([^,]*)/gi)) {
    out.push({ key: `Appendix ${m[1].toUpperCase()}`, title: `Appendix ${m[1].toUpperCase()}${m[2] ?? ''}`.trim() });
  }
  return out;
}

async function taggedRows(plugin: RNPlugin, tag: { id: string; name: string }): Promise<Rem[]> {
  let rem = await plugin.rem.findOne(tag.id);
  if (!rem) {
    // The id moved. Fall back to the tag with this exact name.
    const all = await plugin.search.search([tag.name], undefined, { numResults: 20 }).catch(() => [] as Rem[]);
    for (const r of all) {
      if ((await plain(plugin, r.text)) === tag.name) { rem = r; break; }
    }
  }
  if (!rem) return [];
  return rem.taggedRem();
}

export async function buildCourseMap(plugin: RNPlugin, classId?: string): Promise<CourseMap | undefined> {
  const examRows = await taggedRows(plugin, TAG.exam);
  const lectureRows = await taggedRows(plugin, TAG.lecture);
  const assignRows = await taggedRows(plugin, TAG.assignment);

  // Pick the class: the one asked for, else the class whose next exam is soonest.
  const examsByClass = new Map<string, Array<{ row: Rem; date?: string; topics: string }>>();
  for (const row of examRows) {
    const cls = await slotOf(plugin, row, SLOT.eClass);
    if (!cls.refId) continue;
    const date = isoFromLongDate((await slotOf(plugin, row, SLOT.eDate)).text);
    const topics = (await slotOf(plugin, row, SLOT.eTopics)).text;
    const list = examsByClass.get(cls.refId) ?? [];
    list.push({ row, date, topics });
    examsByClass.set(cls.refId, list);
  }
  let chosen = classId;
  if (!chosen) {
    let best = Number.POSITIVE_INFINITY;
    for (const [id, list] of examsByClass) {
      for (const e of list) {
        if (!e.date) continue;
        const d = daysFromToday(e.date);
        if (d >= 0 && d < best) { best = d; chosen = id; }
      }
    }
    if (!chosen) chosen = examsByClass.keys().next().value;
  }
  if (!chosen) return undefined;

  const classRem = await plugin.rem.findOne(chosen);
  const className = classRem ? await plain(plugin, classRem.text) : 'Class';

  // Chapter facts from the lecture weeks.
  const chapters = new Map<string, Chapter>();
  for (const row of lectureRows) {
    const cls = await slotOf(plugin, row, SLOT.lClass);
    if (cls.refId !== chosen) continue;
    const label = await plain(plugin, row.text);
    const week = label.includes(':') ? label.slice(0, label.indexOf(':')).trim() : label;
    for (const { key, title } of chaptersInLecture(label)) {
      const existing = chapters.get(key);
      if (existing) continue; // first week that teaches it wins
      let cards = 0;
      try { cards = (await row.getCards()).length; } catch { cards = 0; }
      chapters.set(key, { key, label: title, week, remId: row._id, cards });
    }
  }

  // Homework due dates attach to the chapter they name.
  for (const row of assignRows) {
    const cls = await slotOf(plugin, row, SLOT.aClass);
    if (cls.refId !== chosen) continue;
    const label = await plain(plugin, row.text);
    const due = (await slotOf(plugin, row, SLOT.aDue)).text;
    const iso = isoFromLongDate(due);
    const keys = chaptersInLecture(label).map((c) => c.key);
    const bare = /Chapter\s+(\d{1,2})/i.exec(label);
    if (!keys.length && bare) keys.push(bare[1]);
    for (const key of keys) {
      const ch = chapters.get(key) ?? { key, label: `Chapter ${key}`, cards: 0 };
      ch.dueISO = iso;
      ch.dueLabel = due;
      chapters.set(key, ch);
    }
  }

  // Hang each chapter off the exam that tests it.
  const claimed = new Set<string>();
  const exams: ExamNode[] = [];
  for (const e of examsByClass.get(chosen) ?? []) {
    const name = await plain(plugin, e.row.text);
    const keys = chapterKeys(e.topics);
    const cumulative = /cumulative/i.test(name) || /cumulative/i.test(e.topics);
    const list: Chapter[] = [];
    for (const key of keys) {
      const ch = chapters.get(key);
      if (!ch) continue;
      list.push(ch);
      if (!cumulative) claimed.add(key);
    }
    exams.push({
      name,
      cumulative,
      dateISO: e.date,
      dateLabel: (await slotOf(plugin, e.row, SLOT.eDate)).text,
      daysAway: e.date ? daysFromToday(e.date) : undefined,
      remId: e.row._id,
      chapters: list,
    });
  }
  exams.sort((a, b) => (a.dateISO ?? '9').localeCompare(b.dateISO ?? '9'));

  const orphanChapters = Array.from(chapters.values()).filter((c) => !claimed.has(c.key));

  return { className, classId: chosen, exams, orphanChapters, generatedAt: Date.now() };
}
