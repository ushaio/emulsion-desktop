import { useState } from 'react'
import { Check, Copy, FolderInput, Loader2, X } from 'lucide-react'
import type { LocalLibraryCopy } from '../copy'
import type { LocalLibraryImportMode } from '../types'
import { GlassBackdrop } from '@/components/ui/liquid-glass'

/**
 * 导入方式选择弹窗。由「每次询问」开关控制是否出现：开关开启时每次导入都会弹出。
 * 确认时把本次选择记为默认方式；勾选「不再询问」会同时关闭开关。
 */
export function ImportModeDialog({ copy, initialMode, busy, onClose, onConfirm }: {
  copy: LocalLibraryCopy
  /** 上次确认的方式，作为本次默认选中的选项。 */
  initialMode: LocalLibraryImportMode
  busy: boolean
  onClose: () => void
  onConfirm: (mode: LocalLibraryImportMode, remember: boolean) => void
}) {
  const [mode, setMode] = useState<LocalLibraryImportMode>(initialMode)
  const [remember, setRemember] = useState(false)

  const option = (value: LocalLibraryImportMode, icon: React.ReactNode, title: string, hint: string) => {
    const selected = mode === value
    return (
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={busy}
        onClick={() => setMode(value)}
        className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors disabled:opacity-50 ${selected ? '' : 'hover:bg-secondary'}`}
        style={{ borderColor: selected ? 'var(--primary)' : 'var(--border)', backgroundColor: selected ? 'var(--accent)' : undefined }}>
        <span className="mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-xs font-medium">
            {title}
            {selected && <Check size={14} style={{ color: 'var(--primary)' }} />}
          </span>
          <span className="mt-1 block text-[10px] leading-4" style={{ color: 'var(--muted-foreground)' }}>{hint}</span>
        </span>
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-5">
      <button type="button" aria-label={copy.cancelAction} onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div role="dialog" aria-modal="true" className="lg-sheet relative w-full max-w-lg rounded-xl border bg-popover p-5 shadow-2xl" style={{ borderColor: 'var(--border)' }}><GlassBackdrop material="regular" />
        <button type="button" aria-label={copy.cancelAction} disabled={busy} onClick={onClose} className="absolute right-3 top-3 rounded-md p-2 hover:bg-secondary disabled:opacity-50">
          <X size={16} />
        </button>
        <div className="pr-8">
          <h2 className="font-sans text-base font-medium">{copy.importModeTitle}</h2>
          <p className="mt-2 text-xs leading-5" style={{ color: 'var(--muted-foreground)' }}>{copy.importModeBody}</p>
        </div>
        <div className="mt-6 grid gap-2 sm:grid-cols-2" role="radiogroup">
          {option('copy', <Copy size={18} />, copy.copyIntoLibrary, copy.copyIntoLibraryHint)}
          {option('move', <FolderInput size={18} />, copy.moveIntoLibrary, copy.moveIntoLibraryHint)}
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 shrink-0"
            style={{ accentColor: 'var(--primary)' }}
            checked={remember}
            disabled={busy}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium">{copy.importModeRemember}</span>
            <span className="mt-0.5 block text-[10px] leading-4" style={{ color: 'var(--muted-foreground)' }}>{copy.importModeRememberHint}</span>
          </span>
        </label>
        <div className="mt-5 flex items-end justify-between gap-3">
          <p className="min-w-0 text-[10px] leading-4" style={{ color: 'var(--muted-foreground)' }}>{copy.importModeSettingsHint}</p>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="rounded-md border px-3 py-2 text-xs hover:bg-secondary disabled:opacity-50">{copy.cancelAction}</button>
            <button type="button" onClick={() => onConfirm(mode, remember)} disabled={busy}
              className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">
              {busy && <Loader2 size={13} className="animate-spin" />}
              {copy.importModeConfirm}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
