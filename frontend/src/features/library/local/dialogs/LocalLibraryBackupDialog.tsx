import { useState } from 'react'
import { DatabaseBackup, Loader2, RotateCcw, Trash2, X } from 'lucide-react'
import { formatBytes } from '@/lib/utils'
import type { BackupInfo, BackupOverview } from '../types'
import type { LocalLibraryCopy } from '../copy'
import { GlassBackdrop } from '@/components/ui/liquid-glass'

interface Props {
  copy: LocalLibraryCopy
  overview?: BackupOverview
  loading: boolean
  operation: 'create' | 'restore' | 'delete' | null
  onClose: () => void
  onCreate: () => Promise<boolean>
  onRestore: (id: string) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
}

function backupKindLabel(kind: string, copy: LocalLibraryCopy) {
  if (kind === 'daily') return copy.backupKindDaily
  if (kind === 'upgrade') return copy.backupKindUpgrade
  if (kind === 'pre-restore') return copy.backupKindPreRestore
  return copy.backupKindManual
}

function backupMetaLine(backup: BackupInfo, copy: LocalLibraryCopy) {
  return [
    backup.appVersion ? `v${backup.appVersion}` : '',
    backup.schemaVersion ? `${copy.backupMetaSchema} ${backup.schemaVersion}` : '',
    backup.assetCount ? copy.backupMetaAssets.replace('{count}', backup.assetCount.toLocaleString()) : '',
  ].filter(Boolean).join(' · ')
}

export function LocalLibraryBackupDialog({ copy, overview, loading, operation, onClose, onCreate, onRestore, onDelete }: Props) {
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo>()
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo>()
  const busy = operation !== null

  const restore = async () => {
    if (!restoreTarget) return
    if (await onRestore(restoreTarget.id)) {
      setRestoreTarget(undefined)
    }
  }

  const remove = async () => {
    if (!deleteTarget) return
    if (await onDelete(deleteTarget.id)) {
      setDeleteTarget(undefined)
    }
  }

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center p-5">
      <button type="button" aria-label={copy.cancelAction} disabled={busy} className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="local-library-backup-title" className="lg-sheet relative flex max-h-[80vh] w-full max-w-xl flex-col rounded-xl border bg-background shadow-2xl"><GlassBackdrop material="regular" />
        <div className="flex items-center gap-3 border-b p-5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-secondary"><DatabaseBackup size={17} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="local-library-backup-title" className="font-sans text-sm font-semibold">{copy.databaseBackups}</h2>
            <p className="truncate text-[10px] text-muted-foreground">{overview?.libraryRoot}</p>
          </div>
          <button type="button" aria-label={copy.cancelAction} disabled={busy} onClick={onClose} className="rounded-md p-1.5 hover:bg-secondary disabled:opacity-50"><X size={15} /></button>
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex h-36 items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />{copy.loading}</div>
          ) : overview?.backups.length ? (
            <div className="space-y-2">
              {overview.backups.map((backup) => {
                const metaLine = backupMetaLine(backup, copy)
                return (
                <div key={backup.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium">{backupKindLabel(backup.kind, copy)}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground">{new Date(backup.createdAt).toLocaleString()} · {formatBytes(backup.sizeBytes)}</div>
                    {metaLine && <div className="mt-0.5 text-[10px] text-muted-foreground">{metaLine}</div>}
                    {backup.note && <div className="mt-1 truncate text-[11px]" title={backup.note}>{backup.note}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button type="button" disabled={busy} onClick={() => { setRestoreTarget(backup); setDeleteTarget(undefined) }} className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[10px] hover:bg-secondary disabled:opacity-50"><RotateCcw size={11} />{copy.restoreBackup}</button>
                    <button type="button" aria-label={copy.backupDelete} disabled={busy} onClick={() => { setDeleteTarget(backup); setRestoreTarget(undefined) }} className="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] text-muted-foreground transition hover:border-destructive hover:text-destructive disabled:opacity-50" title={copy.backupDelete}><Trash2 size={11} /></button>
                  </div>
                </div>
                )
              })}
            </div>
          ) : (
            <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">{copy.noBackups}</div>
          )}
        </div>

        <div className="flex items-center justify-end border-t p-4">
          <button type="button" disabled={busy || loading} onClick={() => void onCreate()} className="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium disabled:opacity-60" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
            {operation === 'create' ? <Loader2 size={13} className="animate-spin" /> : <DatabaseBackup size={13} />}{operation === 'create' ? copy.backingUp : copy.backupNow}
          </button>
        </div>
      </div>

      {restoreTarget && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-5">
          <div className="absolute inset-0 bg-black/35" />
          <div role="alertdialog" aria-modal="true" aria-labelledby="local-library-restore-title" className="relative w-full max-w-md rounded-xl border bg-background p-5 shadow-2xl">
            <h3 id="local-library-restore-title" className="font-sans text-sm font-semibold">{copy.restoreBackupTitle}</h3>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">{copy.restoreBackupBody}</p>
            <p className="mt-2 text-[11px] text-muted-foreground">{copy.backupRestoreWarning}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setRestoreTarget(undefined)} className="rounded-md border px-3 py-2 text-xs hover:bg-secondary disabled:opacity-50">{copy.cancelAction}</button>
              <button type="button" disabled={busy} onClick={() => void restore()} className="flex items-center gap-2 rounded-md bg-destructive px-3 py-2 text-xs text-destructive-foreground disabled:opacity-60">
                {operation === 'restore' && <Loader2 size={13} className="animate-spin" />}{operation === 'restore' ? copy.restoringBackup : copy.restoreBackup}
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-5">
          <div className="absolute inset-0 bg-black/35" />
          <div role="alertdialog" aria-modal="true" aria-labelledby="local-library-delete-backup-title" className="relative w-full max-w-md rounded-xl border bg-background p-5 shadow-2xl">
            <h3 id="local-library-delete-backup-title" className="font-sans text-sm font-semibold">{copy.backupDeleteTitle}</h3>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">{copy.backupDeleteBody}</p>
            <p className="mt-2 truncate text-[11px] text-muted-foreground">{backupKindLabel(deleteTarget.kind, copy)} · {new Date(deleteTarget.createdAt).toLocaleString()}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setDeleteTarget(undefined)} className="rounded-md border px-3 py-2 text-xs hover:bg-secondary disabled:opacity-50">{copy.cancelAction}</button>
              <button type="button" disabled={busy} onClick={() => void remove()} className="flex items-center gap-2 rounded-md bg-destructive px-3 py-2 text-xs text-destructive-foreground disabled:opacity-60">
                {operation === 'delete' && <Loader2 size={13} className="animate-spin" />}{operation === 'delete' ? copy.backupDeleting : copy.backupDelete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
