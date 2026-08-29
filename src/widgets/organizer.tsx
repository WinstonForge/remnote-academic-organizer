import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import * as React from 'react';
import {
  applyCourseTag,
  applyTitleFix,
  ensureCourseTag,
  runAudit,
  type AuditResult,
  type Finding,
  type FindingKind,
} from '../lib/audit';

const LABELS: Record<FindingKind, string> = {
  title: 'Damaged titles',
  course: 'Untagged courses',
  duplicate: 'Duplicate documents',
  orphan: 'Orphans & unnamed',
};

const BLURB: Record<FindingKind, string> = {
  title: 'Stray markdown, doubled spaces and trailing colons. Safe and reversible.',
  course: 'Course codes with no #Course tag. Applying links them to one shared tag.',
  duplicate: 'Reported only. Choosing a canonical copy is a judgement call, not a rule.',
  orphan: 'Reported only. Empty rems and titles that need a human name.',
};

/** Only these two kinds can be written automatically. */
const APPLICABLE: FindingKind[] = ['title', 'course'];

function Organizer() {
  const plugin = usePlugin();
  const [result, setResult] = React.useState<AuditResult | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState<FindingKind | null>(null);

  const say = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 40));

  const scan = async () => {
    setBusy('Scanning knowledge base…');
    try {
      const r = await runAudit(plugin);
      setResult(r);
      say(`Scanned ${r.scanned} rems (${r.documents} documents), found ${r.findings.length} findings.`);
    } catch (e) {
      say(`Scan failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const grouped = React.useMemo(() => {
    const g: Record<FindingKind, Finding[]> = { title: [], course: [], duplicate: [], orphan: [] };
    for (const f of result?.findings ?? []) g[f.kind].push(f);
    return g;
  }, [result]);

  const apply = async (kind: FindingKind) => {
    const items = grouped[kind];
    if (!items.length) return;
    setBusy(`Applying ${items.length} ${LABELS[kind].toLowerCase()}…`);
    let ok = 0;
    let skipped = 0;
    try {
      if (kind === 'title') {
        for (const f of items) {
          (await applyTitleFix(plugin, f)) ? ok++ : skipped++;
        }
      } else if (kind === 'course') {
        const tag = await ensureCourseTag(plugin);
        if (!tag) {
          say('Could not create the Course tag - nothing applied.');
          return;
        }
        for (const f of items) {
          (await applyCourseTag(plugin, f, tag)) ? ok++ : skipped++;
        }
      }
      say(`${LABELS[kind]}: applied ${ok}, skipped ${skipped}.`);
      await plugin.app.toast(`Applied ${ok} change${ok === 1 ? '' : 's'}.`);
      await scan();
    } catch (e) {
      say(`Apply failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-3 text-sm" style={{ fontFamily: 'inherit' }}>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-base font-semibold m-0">Academic Organizer</h1>
        <button
          onClick={scan}
          disabled={!!busy}
          className="px-3 py-1 rounded bg-blue-60 text-white disabled:opacity-50"
        >
          {result ? 'Re-scan' : 'Scan'}
        </button>
      </div>
      <p className="text-xs opacity-60 mt-0 mb-3">
        Nothing is written until you press Apply. Duplicates and orphans are never changed automatically.
      </p>

      {busy && <div className="mb-3 text-xs opacity-70">{busy}</div>}

      {result && (
        <div className="mb-3 text-xs opacity-70">
          {result.scanned} rems · {result.documents} documents · {result.findings.length} findings
        </div>
      )}

      {result &&
        (Object.keys(LABELS) as FindingKind[]).map((kind) => {
          const items = grouped[kind];
          const canApply = APPLICABLE.includes(kind) && items.length > 0;
          return (
            <div key={kind} className="mb-2 border rounded" style={{ borderColor: 'var(--rn-clr-border-opaque, #ddd)' }}>
              <div className="flex items-center justify-between px-2 py-2">
                <button
                  className="text-left flex-1 bg-transparent border-0 cursor-pointer p-0"
                  onClick={() => setOpen(open === kind ? null : kind)}
                >
                  <span className="font-medium">{LABELS[kind]}</span>{' '}
                  <span className="opacity-60">({items.length})</span>
                </button>
                {canApply && (
                  <button
                    onClick={() => apply(kind)}
                    disabled={!!busy}
                    className="ml-2 px-2 py-1 rounded border text-xs disabled:opacity-50"
                  >
                    Apply {items.length}
                  </button>
                )}
              </div>
              {open === kind && (
                <div className="px-2 pb-2">
                  <p className="text-xs opacity-60 mt-0 mb-2">{BLURB[kind]}</p>
                  <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {items.slice(0, 100).map((f) => (
                      <div key={f.remId + f.kind} className="py-1 text-xs border-t" style={{ borderColor: 'var(--rn-clr-border-opaque, #eee)' }}>
                        <div className="font-mono break-all">{f.current || '[empty]'}</div>
                        {f.proposed && f.kind === 'title' && (
                          <div className="font-mono break-all opacity-80">→ {f.proposed}</div>
                        )}
                        {f.detail && <div className="opacity-50">{f.detail}</div>}
                        <button
                          className="mt-1 underline bg-transparent border-0 p-0 cursor-pointer opacity-60"
                          onClick={() => plugin.window.openRem({ _id: f.remId } as any)}
                        >
                          open
                        </button>
                      </div>
                    ))}
                    {items.length > 100 && (
                      <div className="pt-1 text-xs opacity-50">…and {items.length - 100} more</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

      {log.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium mb-1">Activity</div>
          <div className="text-xs opacity-60" style={{ maxHeight: 140, overflowY: 'auto' }}>
            {log.map((l, i) => (
              <div key={i} className="font-mono">{l}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

renderWidget(Organizer);
