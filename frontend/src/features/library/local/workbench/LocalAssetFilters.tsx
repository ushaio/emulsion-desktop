import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Filter, X } from 'lucide-react'
import type { AssetStructuredFilters, LocalAsset } from '../types'
import type { LocalLibraryCopy } from '../copy'

interface Props {
  copy: LocalLibraryCopy
  filters: AssetStructuredFilters
  /** 网格当前持有的资产，用于推导相机/镜头的「库中已有取值」提示。 */
  assets: LocalAsset[]
  onChange: (filters: AssetStructuredFilters) => void
  onClear: () => void
}

type FilterKey = keyof AssetStructuredFilters

const COLORS = ['red', 'yellow', 'green', 'blue', 'purple'] as const

/**
 * 文件格式分两组平铺，而不是把 14 个开关堆成一堵墙。
 * RAW 名单与 Go 侧 isRAWFormat 完全一致 —— 那也正是「只有内嵌预览、没有可编辑像素」
 * 的那一批，所以这样分组不只是好看，含义也自洽。
 */
const COMMON_FORMATS = ['jpeg', 'png', 'bmp', 'gif', 'webp', 'tiff', 'heif', 'avif']
const RAW_FORMATS = ['cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'rw2', '3fr']

/** 画面方向是单选：后端 buildAssetWhere 用 switch 取单值，故做成「不限 + 三选一」。 */
const ORIENTATION_FILTERS = [
  { value: 'landscape', labelKey: 'landscape' },
  { value: 'portrait', labelKey: 'portrait' },
  { value: 'square', labelKey: 'square' },
] as const

/** 预览状态可多选（后端按 IN 过滤）。取值就是后端实际会写入的那四个。 */
const PREVIEW_STATUS_FILTERS = [
  { value: 'pending', labelKey: 'preview_pending' },
  { value: 'generating', labelKey: 'preview_generating' },
  { value: 'ready', labelKey: 'preview_ready' },
  { value: 'unavailable', labelKey: 'preview_unavailable' },
] as const

/** 「库中已有取值」一次最多提示几个，机型很多时不至于把面板撑满。 */
const SUGGESTION_LIMIT = 8

function numberValue(value: string) {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function dateInputValue(value?: number) {
  if (value === undefined) return ''
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateMilliseconds(value: string, endOfDay = false) {
  if (!value) return undefined
  const timestamp = new Date(`${value}T00:00:00`).getTime()
  return Number.isFinite(timestamp) ? timestamp + (endOfDay ? 86_399_999 : 0) : undefined
}

function activeCount(filters: AssetStructuredFilters) {
  // 「仅显示照片」是浏览范围开关（决定库里什么算一个条目），与工具栏的
  // 「不显示子文件夹」同类，不是按属性收窄的筛选条件 ⇒ 不计入徽标，也不出现在 chips 里。
  // 只有勾选它时才生效（见下方复选框），未设置即表示不过滤。
  const { photosOnly: _photosOnly, ...rest } = filters
  return Object.values(rest).filter((value) => Array.isArray(value) ? value.length > 0 : value !== undefined).length
}

function toggleValue(values: string[] | undefined, value: string) {
  const current = values ?? []
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
}

/** 逗号分隔（半角/全角都认）→ 去重后的取值数组。 */
function splitList(text: string) {
  return [...new Set(text.split(/[,，]/).map((item) => item.trim()).filter(Boolean))]
}

/**
 * 逗号分隔的取值输入（保留原有契约，占位符也写明了这一点），额外提供「库中已有取值」
 * 候选：点一下追加进草稿，仍可自由输入任意值。
 *
 * 候选按钮用 onMouseDown + preventDefault 拦住默认可聚焦行为 —— 否则点击会先把输入框
 * blur 掉、把半成品草稿提交出去。也正因为要照顾草稿，顺手把 Enter 也接上提交，
 * 不必非得失焦。
 */
function TextListInput({ value, placeholder, suggestions, suggestionLabel, onCommit }: {
  value?: string[]
  placeholder: string
  suggestions: string[]
  suggestionLabel: string
  onCommit: (value: string[] | undefined) => void
}) {
  const initialText = (value ?? []).join(', ')
  const [draft, setDraft] = useState({ initialText, text: initialText })
  const text = draft.initialText === initialText ? draft.text : initialText
  const commit = () => {
    const next = splitList(text)
    onCommit(next.length ? next : undefined)
  }
  const used = new Set(splitList(text))
  const options = suggestions.filter((item) => !used.has(item)).slice(0, SUGGESTION_LIMIT)
  return (
    <div className="space-y-1">
      <input
        value={text}
        placeholder={placeholder}
        onChange={(event) => setDraft({ initialText, text: event.target.value })}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          commit()
        }}
        className="h-8 w-full rounded-md border bg-input px-2 text-xs outline-none focus:ring-1"
      />
      {options.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="shrink-0 text-[9px]" style={{ color: 'var(--muted-foreground)' }}>{suggestionLabel}</span>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setDraft({ initialText, text: text ? `${text}, ${option}` : option })}
              className="max-w-[10rem] truncate rounded border px-1.5 py-0.5 text-[10px] hover:bg-secondary"
              style={{ borderColor: 'var(--border)' }}
              title={option}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function LocalAssetFilters({ copy, filters, assets, onChange, onClear }: Props) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const count = activeCount(filters)

  // 相机/镜头没有后端取值接口（不存在 facets 端点），候选值只能从网格已加载的资产里推导。
  // 工作台在首屏之后会把当前查询的剩余页续抓完，所以这里基本等同于全库取值。
  //
  // 注意候选值会随筛选「级联缩小」：筛了 Canon 之后，候选里就只剩 Canon 的机型。
  // 这正是输入框（而非下拉多选）的理由 —— 级联只让**提示**变少，不会阻断输入任意值；
  // 若做成下拉多选，想追加第二个品牌就必须先清掉当前条件，等于走进死胡同。
  // 开销：assets 每次追加一页都会重算一次集合（O(n)），几千张量级下可忽略。
  const cameraSuggestions = useMemo(() => {
    const makes = new Set<string>()
    const models = new Set<string>()
    const lenses = new Set<string>()
    for (const asset of assets) {
      if (asset.exif?.cameraMake) makes.add(asset.exif.cameraMake)
      if (asset.exif?.cameraModel) models.add(asset.exif.cameraModel)
      if (asset.exif?.lensModel) lenses.add(asset.exif.lensModel)
    }
    const sorted = (values: Set<string>) => Array.from(values).sort((a, b) => a.localeCompare(b))
    return { makes: sorted(makes), models: sorted(models), lenses: sorted(lenses) }
  }, [assets])

  // chips 里的取值回显：认不出来就原样显示，保证至少不丢信息。
  const orientationLabel = (value?: string) => {
    const match = ORIENTATION_FILTERS.find((item) => item.value === value)
    return match ? copy[match.labelKey] : (value ?? '')
  }
  const previewStatusLabel = (value: string) => {
    const match = PREVIEW_STATUS_FILTERS.find((item) => item.value === value)
    return match ? copy[match.labelKey] : value
  }

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const update = <K extends FilterKey>(key: K, value: AssetStructuredFilters[K]) => {
    const next = { ...filters, [key]: value }
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key]
    onChange(next)
  }
  const removeMany = (...keys: FilterKey[]) => {
    const next = { ...filters }
    keys.forEach((key) => delete next[key])
    onChange(next)
  }

  const chips = (() => {
    const result: Array<{ key: string, label: string, remove: () => void }> = []
    /** 数值区间的回显，如「800–4096」「≥800」「≤4096」。 */
    const range = (min?: number, max?: number) => {
      if (min !== undefined && max !== undefined) return `${min}–${max}`
      if (min !== undefined) return `≥${min}`
      return `≤${max}`
    }
    const ratingMin = filters.ratingMin as number | undefined
    const ratingMax = filters.ratingMax as number | undefined
    if (ratingMin !== undefined || ratingMax !== undefined) {
      const label = ratingMax === undefined
        ? `${copy.filterRating}: ${ratingMin}+`
        : ratingMin === undefined
          ? `${copy.filterRating}: ≤${ratingMax}`
          : ratingMin === ratingMax
            ? ratingMin === 0 ? `${copy.filterRating}: ${copy.unrated}` : `${copy.filterRating}: ${ratingMin}`
            : `${copy.filterRating}: ${ratingMin}–${ratingMax}`
      result.push({ key: 'rating', label, remove: () => removeMany('ratingMin', 'ratingMax') })
    }
    if (filters.colorLabels?.length) result.push({ key: 'colors', label: `${copy.filterColor}: ${filters.colorLabels.join('/')}`, remove: () => update('colorLabels', undefined) })
    if (filters.uploadStatus && filters.uploadStatus !== 'all') result.push({ key: 'uploadStatus', label: filters.uploadStatus === 'uploaded' ? copy.filterUploaded : copy.filterNotUploaded, remove: () => update('uploadStatus', undefined) })
    if (filters.formats?.length) result.push({ key: 'formats', label: `${copy.filterFormat}: ${filters.formats.join('/')}`, remove: () => update('formats', undefined) })
    if (filters.capturedFromMs !== undefined || filters.capturedToMs !== undefined) result.push({ key: 'captured', label: copy.filterCapturedDate, remove: () => removeMany('capturedFromMs', 'capturedToMs') })
    if (filters.discoveredFromMs !== undefined || filters.discoveredToMs !== undefined) result.push({ key: 'discovered', label: copy.filterDiscoveredDate, remove: () => removeMany('discoveredFromMs', 'discoveredToMs') })
    if (filters.cameraMakes?.length) result.push({ key: 'make', label: `${copy.filterCameraMake}: ${filters.cameraMakes.join('/')}`, remove: () => update('cameraMakes', undefined) })
    if (filters.cameraModels?.length) result.push({ key: 'model', label: `${copy.filterCameraModel}: ${filters.cameraModels.join('/')}`, remove: () => update('cameraModels', undefined) })
    if (filters.lensModels?.length) result.push({ key: 'lens', label: `${copy.filterLens}: ${filters.lensModels.join('/')}`, remove: () => update('lensModels', undefined) })
    if (filters.orientation) result.push({ key: 'orientation', label: `${copy.filterOrientation}: ${orientationLabel(filters.orientation)}`, remove: () => update('orientation', undefined) })
    if (filters.widthMin !== undefined || filters.widthMax !== undefined) result.push({ key: 'width', label: `${copy.filterWidth}: ${range(filters.widthMin, filters.widthMax)}`, remove: () => removeMany('widthMin', 'widthMax') })
    if (filters.heightMin !== undefined || filters.heightMax !== undefined) result.push({ key: 'height', label: `${copy.filterHeight}: ${range(filters.heightMin, filters.heightMax)}`, remove: () => removeMany('heightMin', 'heightMax') })
    if (filters.previewStatuses?.length) result.push({ key: 'previewStatuses', label: `${copy.filterPreview}: ${filters.previewStatuses.map(previewStatusLabel).join('/')}`, remove: () => update('previewStatuses', undefined) })
    return result
  })()

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={copy.filters}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border bg-input px-2.5 text-xs hover:bg-secondary"
      >
        <Filter size={13} />
        <span>{copy.filters}</span>
        {count > 0 && (
          <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[9px] text-primary-foreground">
            {count}
          </span>
        )}
      </button>
      {open && chips.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5" aria-live="polite">
          {chips.map((chip) => <button key={chip.key} type="button" onClick={chip.remove} className="flex items-center gap-1 rounded-full border bg-background px-2 py-1 text-[10px] hover:bg-secondary">{chip.label}<X size={10} /></button>)}
        </div>
      )}
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={copy.filters}
          className="absolute left-3 right-3 top-[calc(100%+4px)] z-30 max-h-[min(60vh,32rem)] overflow-auto rounded-md border bg-background p-4 shadow-xl"
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold">{copy.filters}</h2>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{copy.filterLogicHint}</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label={copy.closeFilters} className="rounded-md p-1.5 hover:bg-secondary"><X size={15} /></button>
          </div>

          {/* 分区顺序按「内容 → 拍摄 → 状态 → 时间 → 整理」推进：先确定在看哪些素材，
              再收窄拍摄条件，然后是它的存在状态，最后是时间与人工标记。
              自动流式排布（auto-fit），窄面板下自动退成单列。 */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-6 gap-y-5">
            <label className="col-span-full flex cursor-pointer items-center gap-2 text-[11px]">
              {/* 默认不勾选。取消勾选时把该项从筛选里移除（而不是留一个 false），
                  这样「有效筛选数」与发给后端的查询都不会带上失效项。 */}
              <input type="checkbox" checked={filters.photosOnly === true} onChange={(event) => update('photosOnly', event.target.checked ? true : undefined)} />
              {copy.photosOnly}
            </label>
            <FilterSection title={copy.filterFormat}>
              <div className="space-y-2">
                <FormatToggles label={copy.filterFormatCommon} formats={COMMON_FORMATS} selected={filters.formats} onToggle={(format) => update('formats', toggleValue(filters.formats, format))} />
                <FormatToggles label={copy.filterFormatRaw} formats={RAW_FORMATS} selected={filters.formats} onToggle={(format) => update('formats', toggleValue(filters.formats, format))} />
              </div>
            </FilterSection>
            <FilterSection title={copy.filterOrientation}>
              <div className="flex flex-wrap gap-1">
                {/* 单选：后端 switch 只认一个值，且传未知值会直接报错 ⇒ 必须给「不限」出口。 */}
                <Toggle active={!filters.orientation} onClick={() => update('orientation', undefined)}>{copy.any}</Toggle>
                {ORIENTATION_FILTERS.map((item) => (
                  <Toggle key={item.value} active={filters.orientation === item.value} onClick={() => update('orientation', filters.orientation === item.value ? undefined : item.value)}>{copy[item.labelKey]}</Toggle>
                ))}
              </div>
            </FilterSection>
            <FilterSection title={copy.filterDimensions}>
              <div className="space-y-2">
                <LabeledRange label={copy.filterWidth} min={filters.widthMin} max={filters.widthMax} onMin={(value) => update('widthMin', value)} onMax={(value) => update('widthMax', value)} />
                <LabeledRange label={copy.filterHeight} min={filters.heightMin} max={filters.heightMax} onMin={(value) => update('heightMin', value)} onMax={(value) => update('heightMax', value)} />
              </div>
            </FilterSection>
            <FilterSection title={copy.filterCamera}>
              <div className="space-y-2">
                <TextListInput value={filters.cameraMakes} placeholder={copy.filterCameraMake} suggestions={cameraSuggestions.makes} suggestionLabel={copy.filterCameraSuggestions} onCommit={(value) => update('cameraMakes', value)} />
                <TextListInput value={filters.cameraModels} placeholder={copy.filterCameraModel} suggestions={cameraSuggestions.models} suggestionLabel={copy.filterCameraSuggestions} onCommit={(value) => update('cameraModels', value)} />
                <TextListInput value={filters.lensModels} placeholder={copy.filterLens} suggestions={cameraSuggestions.lenses} suggestionLabel={copy.filterCameraSuggestions} onCommit={(value) => update('lensModels', value)} />
              </div>
            </FilterSection>
            <FilterSection title={copy.filterUploadStatus}>
              <div className="flex flex-wrap gap-1">
                <Toggle active={!filters.uploadStatus || filters.uploadStatus === 'all'} onClick={() => update('uploadStatus', undefined)}>{copy.any}</Toggle>
                <Toggle active={filters.uploadStatus === 'uploaded'} onClick={() => update('uploadStatus', 'uploaded')}>{copy.filterUploaded}</Toggle>
                <Toggle active={filters.uploadStatus === 'not-uploaded'} onClick={() => update('uploadStatus', 'not-uploaded')}>{copy.filterNotUploaded}</Toggle>
              </div>
            </FilterSection>
            <FilterSection title={copy.filterPreview}>
              <div className="flex flex-wrap gap-1">
                {PREVIEW_STATUS_FILTERS.map((item) => (
                  <Toggle key={item.value} active={filters.previewStatuses?.includes(item.value) ?? false} onClick={() => update('previewStatuses', toggleValue(filters.previewStatuses, item.value))}>{copy[item.labelKey]}</Toggle>
                ))}
              </div>
            </FilterSection>
            <FilterSection title={copy.filterCapturedDate}>
              <DateRange from={filters.capturedFromMs} to={filters.capturedToMs} copy={copy} onFrom={(value) => update('capturedFromMs', value)} onTo={(value) => update('capturedToMs', value)} />
            </FilterSection>
            <FilterSection title={copy.filterDiscoveredDate}>
              <DateRange from={filters.discoveredFromMs} to={filters.discoveredToMs} copy={copy} onFrom={(value) => update('discoveredFromMs', value)} onTo={(value) => update('discoveredToMs', value)} />
            </FilterSection>
            <FilterSection title={copy.filterRating}>
              <RangeInputs min={filters.ratingMin} max={filters.ratingMax} minLimit={0} maxLimit={5} onMin={(value) => update('ratingMin', value)} onMax={(value) => update('ratingMax', value)} />
            </FilterSection>
            <FilterSection title={copy.filterColor}>
              <div className="flex flex-wrap gap-2">
                {COLORS.map((color) => {
                  const active = filters.colorLabels?.includes(color) ?? false
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => update('colorLabels', toggleValue(filters.colorLabels, color))}
                      title={copy[color]}
                      aria-label={copy[color]}
                      aria-pressed={active}
                      className="relative h-6 w-6 rounded-full border transition-transform hover:scale-110"
                      style={{
                        backgroundColor: color,
                        borderColor: active ? 'var(--foreground)' : 'var(--border)',
                        boxShadow: active ? '0 0 0 2px var(--background), 0 0 0 4px var(--foreground)' : undefined,
                      }}
                    >
                      {active && <Check size={13} className="absolute inset-0 m-auto" style={{ color: 'white', filter: 'drop-shadow(0 0 1.5px rgba(0,0,0,0.9))' }} />}
                    </button>
                  )
                })}
              </div>
            </FilterSection>
          </div>

          <div className="mt-5 flex items-center justify-between border-t pt-3">
            <button type="button" disabled={count === 0} onClick={onClear} className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-[10px] hover:bg-secondary disabled:opacity-40"><X size={11} />{copy.clearFilters}</button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md bg-primary px-4 py-1.5 text-[10px] font-medium text-primary-foreground hover:opacity-90">{copy.filterDone}</button>
          </div>
        </div>
      )}
    </>
  )
}

function FilterSection({ title, children }: { title: string, children: ReactNode }) {
  return <section><h3 className="mb-2 text-[11px] font-medium">{title}</h3>{children}</section>
}

/** 一组格式开关 + 组标签。组标签只在有内容时渲染，避免空组留白。 */
function FormatToggles({ label, formats, selected, onToggle }: { label: string, formats: readonly string[], selected?: string[], onToggle: (format: string) => void }) {
  return (
    <div>
      <div className="mb-1 text-[9px]" style={{ color: 'var(--muted-foreground)' }}>{label}</div>
      <div className="flex flex-wrap gap-1">
        {formats.map((format) => (
          <Toggle key={format} active={selected?.includes(format) ?? false} onClick={() => onToggle(format)}>{format.toUpperCase()}</Toggle>
        ))}
      </div>
    </div>
  )
}

/** 带标签的数值区间。尺寸这类「有量纲」的区间必须带单位说明，否则 Min/Max 无所指。 */
function LabeledRange({ label, min, max, onMin, onMax }: { label: string, min?: number, max?: number, onMin: (value?: number) => void, onMax: (value?: number) => void }) {
  return (
    <div>
      <div className="mb-1 text-[9px]" style={{ color: 'var(--muted-foreground)' }}>{label}</div>
      <RangeInputs min={min} max={max} minLimit={0} onMin={onMin} onMax={onMax} />
    </div>
  )
}

function Toggle({ active, onClick, children }: { active: boolean, onClick: () => void, children: ReactNode }) {
  return <button type="button" onClick={onClick} className="rounded-md border px-2 py-1 text-[10px]" style={{ backgroundColor: active ? 'var(--accent)' : undefined, borderColor: active ? 'var(--primary)' : 'var(--border)' }}>{children}</button>
}

function RangeInputs({ min, max, minLimit, maxLimit, step, onMin, onMax }: { min?: number, max?: number, minLimit?: number, maxLimit?: number, step?: string, onMin: (value?: number) => void, onMax: (value?: number) => void }) {
  return <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2"><input type="number" value={min ?? ''} min={minLimit} max={maxLimit} step={step} placeholder="Min" onChange={(event) => onMin(numberValue(event.target.value))} className="h-8 min-w-0 rounded-md border bg-input px-2 text-xs" /><span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>–</span><input type="number" value={max ?? ''} min={minLimit} max={maxLimit} step={step} placeholder="Max" onChange={(event) => onMax(numberValue(event.target.value))} className="h-8 min-w-0 rounded-md border bg-input px-2 text-xs" /></div>
}

function DateRange({ from, to, copy, onFrom, onTo }: { from?: number, to?: number, copy: LocalLibraryCopy, onFrom: (value?: number) => void, onTo: (value?: number) => void }) {
  return <div className="grid grid-cols-2 gap-2"><label className="text-[9px]" style={{ color: 'var(--muted-foreground)' }}>{copy.from}<input type="date" value={dateInputValue(from)} onChange={(event) => onFrom(dateMilliseconds(event.target.value))} className="mt-1 h-8 w-full rounded-md border bg-input px-2 text-xs" /></label><label className="text-[9px]" style={{ color: 'var(--muted-foreground)' }}>{copy.to}<input type="date" value={dateInputValue(to)} onChange={(event) => onTo(dateMilliseconds(event.target.value, true))} className="mt-1 h-8 w-full rounded-md border bg-input px-2 text-xs" /></label></div>
}
