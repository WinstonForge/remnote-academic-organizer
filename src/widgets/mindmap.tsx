import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import * as React from 'react';
import { buildCourseMap, type Chapter, type CourseMap, type ExamNode } from '../lib/mindmap';

/**
 * A study map for one class: the course at the centre, each exam on its own
 * branch, and under each exam the chapters it tests. Built from the class
 * tables, so it stays true as the tables change.
 */

const W = 1180;
const H = 760;
const CX = W / 2;
const CY = H / 2;

// One hue per exam branch, so a chapter's colour says which exam owns it.
const BRANCH = ['#2f6fd0', '#0f9d73', '#b4671b', '#7a4fd0', '#b03a63'];

type Placed = {
  chapter: Chapter;
  x: number;
  y: number;
  angle: number;
  colour: string;
  examName: string;
};

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** A curve from parent to child reads as a branch, not a wire. */
function branchPath(x1: number, y1: number, x2: number, y2: number) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(38, len * 0.18);
  const nx = (-dy / len) * bow;
  const ny = (dx / len) * bow;
  return `M ${x1} ${y1} Q ${mx + nx} ${my + ny} ${x2} ${y2}`;
}

function dueTone(days: number | undefined): string {
  if (days === undefined) return 'var(--rn-clr-content-tertiary, #8a8f98)';
  if (days < 0) return '#8a8f98';
  if (days <= 7) return '#c2410c';
  if (days <= 21) return '#a16207';
  return 'var(--rn-clr-content-secondary, #5b6270)';
}

function MindMap() {
  const plugin = usePlugin();
  const [map, setMap] = React.useState<CourseMap | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [hover, setHover] = React.useState<string | null>(null);
  const [focusExam, setFocusExam] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const m = await buildCourseMap(plugin);
      if (!m) setError('No class with exams found. Build the class tables first.');
      setMap(m ?? null);
    } catch (e) {
      setError(String(e));
    }
  }, [plugin]);

  React.useEffect(() => { void load(); }, [load]);

  const open = async (remId?: string) => {
    if (!remId) return;
    const rem = await plugin.rem.findOne(remId);
    if (rem) await plugin.window.openRem(rem);
  };

  if (error) {
    return <div style={{ padding: 24, fontFamily: 'inherit' }}>{error}</div>;
  }
  if (!map) {
    return <div style={{ padding: 24, opacity: 0.7 }}>Reading the class tables…</div>;
  }

  // A cumulative final earns a branch even though repeating every chapter leaf
  // under it would just duplicate the rest of the map.
  const exams = map.exams.filter((e) => e.chapters.length > 0 || e.cumulative);
  const shown = focusExam ? exams.filter((e) => e.name === focusExam) : exams;

  // Lay the exam branches around the centre, then fan each exam's chapters
  // across the wedge that branch owns.
  const spanPer = 360 / Math.max(shown.length, 1);
  const examNodes: Array<{ exam: ExamNode; x: number; y: number; colour: string; angle: number }> = [];
  const chapterNodes: Placed[] = [];

  shown.forEach((exam, i) => {
    const colour = BRANCH[exams.indexOf(exam) % BRANCH.length];
    const angle = i * spanPer + spanPer / 2;
    const p = polar(CX, CY, 152, angle);
    examNodes.push({ exam, x: p.x, y: p.y, colour, angle });

    const leaves = exam.cumulative ? [] : exam.chapters;
    const n = leaves.length;
    const spread = Math.min(spanPer * 0.92, 30 * n);
    leaves.forEach((chapter, j) => {
      const a = angle - spread / 2 + (n === 1 ? spread / 2 : (spread * j) / (n - 1));
      // Three rings, so neighbouring leaves never sit at the same radius.
      const radius = 282 + (j % 3) * 54;
      const q = polar(CX, CY, radius, a);
      chapterNodes.push({ chapter, x: q.x, y: q.y, angle: a, colour, examName: exam.name });
    });
  });

  const next = exams.find((e) => (e.daysAway ?? -1) >= 0);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--rn-clr-background-primary, #fff)',
        color: 'var(--rn-clr-content-primary, #16181d)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 16,
          flexWrap: 'wrap',
          padding: '14px 20px 10px',
          borderBottom: '1px solid var(--rn-clr-border-primary, #e6e8ec)',
        }}
      >
        <strong style={{ fontSize: 17, letterSpacing: '-0.01em' }}>{map.className}</strong>
        <span style={{ fontSize: 13, opacity: 0.75 }}>study map</span>
        {next && (
          <span style={{ fontSize: 13, color: dueTone(next.daysAway), fontWeight: 600 }}>
            Next: {next.name} · {next.dateLabel}
            {next.daysAway !== undefined && ` · ${next.daysAway} day${next.daysAway === 1 ? '' : 's'} away`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setFocusExam(null)}
          style={{
            ...btn,
            fontWeight: focusExam ? 400 : 600,
            opacity: focusExam ? 0.7 : 1,
          }}
        >
          All exams
        </button>
        {exams.map((e, i) => (
          <button
            key={e.name}
            onClick={() => setFocusExam(focusExam === e.name ? null : e.name)}
            style={{
              ...btn,
              borderColor: BRANCH[i % BRANCH.length],
              color: BRANCH[i % BRANCH.length],
              fontWeight: focusExam === e.name ? 700 : 500,
            }}
          >
            {e.name}
          </button>
        ))}
        <button onClick={() => void load()} style={btn}>Refresh</button>
      </header>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%', minHeight: 620 }}>
          {examNodes.map(({ exam, x, y, colour }) => (
            <path
              key={`spine-${exam.name}`}
              d={branchPath(CX, CY, x, y)}
              fill="none"
              stroke={colour}
              strokeWidth={3.5}
              strokeLinecap="round"
              opacity={0.85}
            />
          ))}
          {chapterNodes.map((c) => {
            const parent = examNodes.find((e) => e.exam.name === c.examName);
            if (!parent) return null;
            return (
              <path
                key={`twig-${c.examName}-${c.chapter.key}`}
                d={branchPath(parent.x, parent.y, c.x, c.y)}
                fill="none"
                stroke={c.colour}
                strokeWidth={hover === c.chapter.key ? 2.6 : 1.5}
                strokeLinecap="round"
                opacity={hover && hover !== c.chapter.key ? 0.25 : 0.6}
              />
            );
          })}

          {/* Centre: the course itself */}
          <g onClick={() => void open(map.classId)} style={{ cursor: 'pointer' }}>
            <circle cx={CX} cy={CY} r={62} fill="var(--rn-clr-background-primary, #fff)"
              stroke="var(--rn-clr-content-primary, #16181d)" strokeWidth={2.5} />
            <text x={CX} y={CY - 4} textAnchor="middle" fontSize={17} fontWeight={700}
              fill="var(--rn-clr-content-primary, #16181d)">
              {map.className.split(' ')[0]}
            </text>
            <text x={CX} y={CY + 16} textAnchor="middle" fontSize={13}
              fill="var(--rn-clr-content-secondary, #5b6270)">
              {map.className.split(' ')[1] ?? ''}
            </text>
          </g>

          {examNodes.map(({ exam, x, y, colour }) => (
            <g key={exam.name} onClick={() => void open(exam.remId)} style={{ cursor: 'pointer' }}>
              <rect x={x - 74} y={y - 25} width={148} height={50} rx={12} fill={colour} />
              <text x={x} y={y - 5} textAnchor="middle" fontSize={14} fontWeight={700} fill="#fff">
                {exam.name}
              </text>
              <text x={x} y={y + 13} textAnchor="middle" fontSize={11.5} fill="#ffffffd8">
                {exam.dateLabel?.replace(/,\s*\d{4}$/, '') ?? 'date to confirm'}
                {exam.daysAway !== undefined && exam.daysAway >= 0 ? ` · ${exam.daysAway}d` : ''}
              </text>
              {exam.cumulative && (
                <text x={x} y={y + 40} textAnchor="middle" fontSize={11}
                  fill="var(--rn-clr-content-secondary, #5b6270)">
                  covers all {exam.chapters.length} chapters
                </text>
              )}
            </g>
          ))}

          {chapterNodes.map((c) => {
            const dim = hover !== null && hover !== c.chapter.key;
            const days = c.chapter.dueISO
              ? Math.round((new Date(`${c.chapter.dueISO}T00:00:00`).getTime() - Date.now()) / 86400000)
              : undefined;
            const title = c.chapter.label.length > 34
              ? `${c.chapter.label.slice(0, 33)}…`
              : c.chapter.label;
            return (
              <g
                key={`${c.examName}-${c.chapter.key}`}
                onMouseEnter={() => setHover(c.chapter.key)}
                onMouseLeave={() => setHover(null)}
                onClick={() => void open(c.chapter.remId)}
                style={{ cursor: 'pointer', opacity: dim ? 0.4 : 1 }}
              >
                <rect
                  x={c.x - 104} y={c.y - 25} width={208} height={c.chapter.dueLabel ? 52 : 38} rx={10}
                  fill="var(--rn-clr-background-primary, #fff)"
                  stroke={c.colour}
                  strokeWidth={hover === c.chapter.key ? 2.2 : 1.3}
                />
                <text x={c.x} y={c.y - 7} textAnchor="middle" fontSize={12.5} fontWeight={600}
                  fill="var(--rn-clr-content-primary, #16181d)">
                  {title}
                </text>
                {c.chapter.dueLabel && (
                  <text x={c.x} y={c.y + 11} textAnchor="middle" fontSize={11} fill={dueTone(days)}>
                    HW {c.chapter.dueLabel.replace(/,\s*\d{4}$/, '')}
                    {days !== undefined && days >= 0 ? ` · ${days}d` : days !== undefined ? ' · past' : ''}
                  </text>
                )}
                {c.chapter.week && (
                  <text x={c.x} y={c.y + (c.chapter.dueLabel ? 24 : 10)} textAnchor="middle" fontSize={10}
                    fill="var(--rn-clr-content-tertiary, #8a8f98)">
                    {c.chapter.week}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <footer
        style={{
          padding: '9px 20px',
          borderTop: '1px solid var(--rn-clr-border-primary, #e6e8ec)',
          fontSize: 12,
          color: 'var(--rn-clr-content-secondary, #5b6270)',
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
        }}
      >
        <span>Click any node to open it in RemNote.</span>
        <span>{exams.length} exams · {chapterNodes.length} chapter branches</span>
        {map.orphanChapters.length > 0 && (
          <span>Not on any exam: {map.orphanChapters.map((c) => c.label).join(', ')}</span>
        )}
      </footer>
    </div>
  );
}

const btn: React.CSSProperties = {
  fontSize: 12.5,
  padding: '4px 11px',
  borderRadius: 999,
  border: '1px solid var(--rn-clr-border-primary, #d7dae0)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
};

renderWidget(MindMap);
