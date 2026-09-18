import { CheckCircle2, Database, Loader2, X } from 'lucide-react'
import type { LibraryUpgradeInfo } from '../types'
import type { LocalLibraryCopy } from '../copy'
import { releaseNotesFor } from '../release-notes'
import { GlassBackdrop } from '@/components/ui/liquid-glass'

interface Props {
  copy: LocalLibraryCopy
  info: LibraryUpgradeInfo
  phase: 'confirm' | 'running' | 'completed' | 'failed'
  error?: string
  /** Position in a "upgrade all" run; a total of 0 or 1 means a single library. */
  progress?: { current: number; total: number }
  onStart: () => void
  onUpgradeAll: () => void
  onCancel: () => void
  onConfirm: () => void
}

function replaceVersion(copy: string, info: LibraryUpgradeInfo) {
  return copy.replace('{current}', String(info.currentVersion)).replace('{target}', String(info.targetVersion))
}

export function LocalLibraryUpgradeDialog({ copy, info, phase, error, progress, onStart, onUpgradeAll, onCancel, onConfirm }: Props) {
  const busy = phase === 'running'
  const completed = phase === 'completed'
  // What the user is actually getting, which is the upgrade target's notes
  // rather than the version they are leaving.
  const notes = releaseNotesFor(info.targetVersion)
  const batchTotal = progress?.total ?? 0
  const runningLabel = batchTotal > 1
    ? copy.upgradeStep.replace('{current}', String(progress?.current ?? 1)).replace('{total}', String(batchTotal))
    : copy.upgradeRunning

  return (
    <div className="fixed inset-0 z-[160] flex items-center justify-center p-5">
      <button type="button" aria-label={copy.upgradeCancel} disabled={busy || completed} className="absolute inset-0 bg-black/55 backdrop-blur-sm disabled:cursor-not-allowed" onClick={onCancel} />
      {/* Height follows the content: a short release note list stays a short
          dialog, and only a long one scrolls (capped by max-h). */}
      <div role="dialog" aria-modal="true" aria-labelledby="local-library-upgrade-title" className="lg-sheet relative flex max-h-[min(560px,calc(100vh-40px))] w-full max-w-md flex-col rounded-xl border bg-background shadow-2xl" style={{ borderColor: 'var(--border)' }}><GlassBackdrop material="regular" />
        <div className="flex shrink-0 items-start gap-3 border-b p-5" style={{ borderColor: 'var(--border)' }}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
            {completed ? <CheckCircle2 size={18} className="text-emerald-500" /> : <Database size={17} />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="local-library-upgrade-title" className="font-sans text-sm font-semibold">{completed ? copy.upgradeDoneTitle : copy.upgradeTitle}</h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{completed ? copy.upgradeDoneBody : copy.upgradeBody}</p>
          </div>
          <button type="button" aria-label={copy.upgradeCancel} disabled={busy || completed} onClick={onCancel} className="rounded-md p-1.5 hover:bg-secondary disabled:opacity-40"><X size={15} /></button>
        </div>

        {/* The only scrolling region, so the header and the buttons stay put. */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          <div className="rounded-lg border bg-card px-3 py-2 text-xs" style={{ borderColor: 'var(--border)' }}>
            <div className="font-medium">{replaceVersion(copy.upgradeVersion, info)}</div>
            <div className="mt-1 truncate text-[10px] text-muted-foreground">{info.rootPath}</div>
          </div>
          {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />{runningLabel}</div>}
          {phase === 'failed' && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error || copy.upgradeFailed}</div>}

          {notes.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{copy.upgradeNotes}</span>
                <span>{copy.upgradeNotesVersion.replace('{version}', String(info.targetVersion))}</span>
              </div>
              <ul className="space-y-1.5 rounded-lg border bg-secondary px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
                {notes.map((note) => (
                  <li key={note} className="flex gap-2 text-[11px] leading-5">
                    <span className="mt-[7px] size-1 shrink-0 rounded-full bg-current opacity-40" />
                    <span className="min-w-0">{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t p-4" style={{ borderColor: 'var(--border)' }}>
          {!completed && <button type="button" disabled={busy} onClick={onCancel} className="rounded-md border px-3 py-2 text-xs hover:bg-secondary disabled:opacity-50">{copy.upgradeCancel}</button>}
          {phase === 'confirm' || phase === 'failed' ? (
            <>
              <button type="button" title={copy.upgradeAllHint} onClick={onUpgradeAll} className="rounded-md border px-3 py-2 text-xs hover:bg-secondary">{copy.upgradeAll}</button>
              <button type="button" onClick={onStart} className="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
                {copy.upgradeStart}
              </button>
            </>
          ) : completed ? (
            <button type="button" onClick={onConfirm} className="rounded-md px-3 py-2 text-xs font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>{copy.upgradeConfirm}</button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
