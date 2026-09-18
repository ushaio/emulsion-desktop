import { useState } from 'react'
import { Check, Copy, Loader2, Replace, X } from 'lucide-react'
import type { LocalLibraryCopy } from '../copy'
import type { LocalImageEditMode } from '../types'
import { GlassBackdrop } from '@/components/ui/liquid-glass'

/**
 * 编辑结果的保存方式。覆盖是破坏性操作，所以默认选中更安全的副本，并把两者的
 * 后果分别写在选项里，让用户在按下确认前就知道会发生什么。
 */
export function ImageSaveModeDialog({ copy, outputSize, targetFolder, saving, onClose, onConfirm }: {
  copy: LocalLibraryCopy
  outputSize: { width: number, height: number }
  /** 副本落地的文件夹，相对资源库根；空串表示根目录。 */
  targetFolder: string
  saving: boolean
  onClose: () => void
  onConfirm: (mode: LocalImageEditMode) => void
}) {
  const [mode, setMode] = useState<LocalImageEditMode>('copy')

  const option = (value: LocalImageEditMode, icon: React.ReactNode, title: string, hint: string) => {
    const selected = mode === value
    return (
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={saving}
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
      <div role="dialog" aria-modal="true" className="lg-sheet relative w-full max-w-lg rounded-xl border bg-popover p-5 text-foreground shadow-2xl" style={{ borderColor: 'var(--border)' }}>
        <GlassBackdrop material="regular" />
        <button type="button" aria-label={copy.cancelAction} disabled={saving} onClick={onClose} className="absolute right-3 top-3 rounded-md p-2 hover:bg-secondary disabled:opacity-50">
          <X size={16} />
        </button>
        <div className="pr-8">
          <h2 className="font-sans text-base font-medium">{copy.editSaveTitle}</h2>
          <p className="mt-2 text-xs leading-5" style={{ color: 'var(--muted-foreground)' }}>{copy.editSaveBody}</p>
          <p className="mt-1 text-[10px] leading-4" style={{ color: 'var(--muted-foreground)' }}>
            {copy.editOutputSize.replace('{width}', String(outputSize.width)).replace('{height}', String(outputSize.height))}
          </p>
        </div>
        <div className="mt-6 grid gap-2 sm:grid-cols-2" role="radiogroup">
          {option('copy', <Copy size={18} />, copy.editSaveCopy, copy.editSaveCopyHint)}
          {option('overwrite', <Replace size={18} />, copy.editOverwrite, copy.editOverwriteHint)}
        </div>
        <p className="mt-3 text-[10px] leading-4" style={{ color: 'var(--muted-foreground)' }}>
          {copy.editSaveTo.replace('{path}', targetFolder || copy.root)}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-md border px-3 py-2 text-xs hover:bg-secondary disabled:opacity-50">{copy.cancelAction}</button>
          <button type="button" onClick={() => onConfirm(mode)} disabled={saving}
            className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">
            {saving && <Loader2 size={13} className="animate-spin" />}
            {saving ? copy.editApplying : copy.save}
          </button>
        </div>
      </div>
    </div>
  )
}
