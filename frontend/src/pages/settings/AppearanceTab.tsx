import { useRef, useState, type CSSProperties } from 'react'
import { Check, CheckSquare, FolderInput, Grid2X2, Heart, Image, List, Monitor, Moon, RotateCcw, Sun, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { usePreferences } from '@/store/preferences'
import { ACCENTS, DEFAULT_ACCENT, glassAccentTheme, glassAccentGradient } from '@/lib/accents'
import {
  GLASS_DEFAULTS,
  GLASS_RANGES,
  REFRACTION_MODES,
  type RefractionMode,
} from '@/lib/liquid-glass'
import { useTheme } from '@/contexts/ThemeContext'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { GlassButton, GlassDock, GlassSurface } from '@/components/ui/liquid-glass'
import { CustomInput } from '@/components/ui/CustomInput'
import { SelectDropdown } from '@/components/ui/SelectDropdown'
import { LibrarySelectionBar, LibrarySelectionButton } from '@/components/ui/library'

/**
 * 外观预览台。一块缩小的真实画布：同样的光幕、同样挂在 JS 材质上的玻璃，
 * 把参数改动立刻显示出来。
 *
 * `mouseContainer` 指向这块画布本身，于是玻璃会跟着指针在画布内移动而倾斜、
 * 拉伸——弹性（elasticity）这个参数只能这样看出来。上游同样支持用一个更大的
 * 容器做追踪区，这里刻意选了小块：监听器挂在容器上，画布越大、指针事件的
 * 面积越大，而这只在设置页用得到。
 */
export function AppearancePreview() {
  const language = usePreferences(state => state.language)
  const zh = language === 'zh'
  const stageRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState('grid')
  const [favorite, setFavorite] = useState(false)
  const [size, setSize] = useState(176)
  const [showDetails, setShowDetails] = useState(true)
  const [title, setTitle] = useState('Emulsion')
  const [sort, setSort] = useState('recent')
  const [selected, setSelected] = useState(24)
  const allSelected = selected >= 96

  return (
    <div className="appearance-specimen" ref={stageRef} aria-label={zh ? '外观预览' : 'Appearance preview'}>
      <GlassSurface
        className="appearance-specimen-panel"
        material="regular"
        cornerRadius={14}
        padding="22px"
        mouseContainer={stageRef}
      >
        <div className="appearance-specimen-head">
          <span>{zh ? '资源库' : 'Library'}</span>
          <SlidersHorizontal size={16} aria-hidden="true" />
        </div>
        <SegmentedTabs value={view} onChange={setView} ariaLabel={zh ? '照片视图' : 'Photo view'} semantic="radio" options={[
          { value: 'grid', label: zh ? '网格' : 'Grid', icon: Grid2X2 },
          { value: 'list', label: zh ? '列表' : 'List', icon: List },
        ]} />
        <label className="appearance-specimen-label">
          <span>{zh ? '名称' : 'Name'}</span>
          <CustomInput variant="config" value={title} onChange={event => setTitle(event.target.value)} maxLength={40} className="appearance-specimen-input" />
        </label>
        <div className="appearance-specimen-label">
          <span>{zh ? '排列方式' : 'Sort by'}</span>
          <SelectDropdown value={sort} onChange={value => setSort(String(value))} ariaLabel={zh ? '排列方式' : 'Sort by'} className="appearance-specimen-select" options={[
            { value: 'recent', label: zh ? '最近添加' : 'Recently added' },
            { value: 'name', label: zh ? '文件名称' : 'File name' },
          ]} />
        </div>
        <label className="appearance-specimen-label">
          <span>{zh ? '缩略图' : 'Thumbnails'} <span className="tabular-nums">{size}</span></span>
          <input className="appearance-range" type="range" min="96" max="256" step="8" value={size}
            onChange={event => setSize(Number(event.target.value))}
            style={{ '--lg-range-fill': `${((size - 96) / 160) * 100}%` } as CSSProperties} />
        </label>
        <label className="appearance-specimen-label">
          <span>{zh ? '显示文件信息' : 'File information'}</span>
          <input className="appearance-switch" type="checkbox" role="switch" checked={showDetails} onChange={event => setShowDetails(event.target.checked)} />
        </label>
      </GlassSurface>
      <div className="appearance-specimen-footer">
        <GlassDock icons={[
          { icon: <Grid2X2 size={20} />, alt: zh ? '网格视图' : 'Grid view', active: view === 'grid', onClick: () => setView('grid') },
          { icon: <List size={20} />, alt: zh ? '列表视图' : 'List view', active: view === 'list', onClick: () => setView('list') },
          { icon: <Image size={20} />, alt: zh ? '文件信息' : 'File information', active: showDetails, onClick: () => setShowDetails(!showDetails) },
        ]} />
        <GlassButton onClick={() => setFavorite(!favorite)} aria-pressed={favorite}>
          <Heart size={16} fill={favorite ? 'currentColor' : 'none'} />
          {favorite ? (zh ? '已收藏' : 'Saved') : (zh ? '收藏' : 'Save')}
        </GlassButton>
      </div>
      <div className="appearance-specimen-selection">
        <LibrarySelectionBar countLabel={`${zh ? '已选择' : 'Selected'} ${selected.toLocaleString()}`}>
          <LibrarySelectionButton
            icon={CheckSquare}
            label={allSelected ? (zh ? '取消全选' : 'Deselect all') : (zh ? '全选' : 'Select all')}
            title={allSelected ? (zh ? '取消全选' : 'Deselect all') : (zh ? '全选' : 'Select all')}
            active={allSelected}
            onClick={() => setSelected(allSelected ? 24 : 96)}
          />
          <LibrarySelectionButton
            icon={FolderInput}
            label={zh ? '移动到文件夹' : 'Move to folder'}
            title={zh ? '需要先连接存储源' : 'Connect a storage source first'}
            disabled
            onClick={() => {}}
          />
          <LibrarySelectionButton
            icon={Trash2}
            label={zh ? '删除所选' : 'Delete selected'}
            title={zh ? '删除所选' : 'Delete selected'}
            intent="destructive"
            disabled={selected === 0}
            onClick={() => setSelected(0)}
          />
          <div className="mx-0.5 h-4 w-px" style={{ backgroundColor: 'var(--border)' }} />
          <LibrarySelectionButton
            icon={X}
            label={zh ? '取消选择' : 'Clear selection'}
            title={zh ? '取消选择 (Esc)' : 'Clear selection (Esc)'}
            disabled={selected === 0}
            onClick={() => setSelected(0)}
          />
        </LibrarySelectionBar>
      </div>
    </div>
  )
}

/** 一个可拖动的材质参数。滑杆的填充比例由 --lg-range-fill 驱动。 */
function TuningRow({
  label,
  value,
  display,
  rangeKey,
  onChange,
}: {
  label: string
  value: number
  display: string
  rangeKey: keyof typeof GLASS_RANGES
  onChange: (value: number) => void
}) {
  const { min, max, step } = GLASS_RANGES[rangeKey]
  return (
    <label className="appearance-tuning">
      <span>{label}</span>
      <span className="flex items-center gap-3">
        <input
          className="appearance-range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={event => onChange(Number(event.target.value))}
          style={{ '--lg-range-fill': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
        />
        <span className="appearance-tuning-value">{display}</span>
      </span>
    </label>
  )
}

export function AppearanceTab() {
  const {
    theme, setTheme,
    accent, setAccent,
    appearance, setAppearance,
    glassCanvas, setGlassCanvas,
    reduceTransparency, setReduceTransparency,
    sidebarFrosted, setSidebarFrosted,
    mode, refraction, aberration, frost, elasticity,
    setGlassMode, setGlassTuning, resetGlassTuning,
    language,
  } = usePreferences()
  const { resolvedTheme } = useTheme()
  const zh = language === 'zh'
  const glass = appearance === 'liquid-glass'
  const themeChoices = [
    { value: 'light' as const, label: zh ? '浅色' : 'Light', icon: Sun },
    { value: 'dark' as const, label: zh ? '深色' : 'Dark', icon: Moon },
    { value: 'system' as const, label: zh ? '跟随系统' : 'System', icon: Monitor },
  ]
  const tuningTouched =
    mode !== GLASS_DEFAULTS.mode
    || refraction !== GLASS_DEFAULTS.refraction
    || aberration !== GLASS_DEFAULTS.aberration
    || frost !== GLASS_DEFAULTS.frost
    || elasticity !== GLASS_DEFAULTS.elasticity

  const handleAccentChange = (id: (typeof ACCENTS)[number]['id']) => {
    setAccent(id)
    if (!glass && id !== DEFAULT_ACCENT && theme !== 'light') setTheme('light')
  }

  return (
    <div className="appearance-settings">
      <div className="appearance-row">
        <span className="appearance-label">{zh ? '明暗外观' : 'Appearance'}</span>
        <SegmentedTabs semantic="radio" ariaLabel={zh ? '明暗外观' : 'Appearance'} value={theme} onChange={setTheme} options={themeChoices} />
      </div>
      <fieldset className="mt-5 min-w-0">
        <legend className="appearance-label">{zh ? '主题风格' : 'Theme style'}</legend>
        <div className="appearance-presets">
          {(['classic', 'liquid-glass'] as const).map(preset => (
            <label key={preset} className="appearance-preset" data-preset={preset}>
              <input type="radio" name="appearance-style" value={preset} checked={appearance === preset} onChange={() => setAppearance(preset)} />
              <span className="appearance-preset-frame" aria-hidden="true"><span><i /><i /><i /><i /></span><span><i /><i /><i /></span></span>
              <span className="appearance-preset-name">
                {preset === 'classic' ? (zh ? '经典' : 'Classic') : (zh ? '液态玻璃' : 'Liquid Glass')}
                {appearance === preset && <Check size={14} aria-hidden="true" />}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {!glass && (
        <p className="appearance-note">
          {zh
            ? '液态玻璃是一套完整的界面材质：背景光幕、窗口栏、侧栏、面板、弹窗、菜单与控件都由它统一绘制。'
            : 'Liquid Glass is a complete interface material: backdrop, chrome, panels, dialogs, menus and controls are all drawn by it.'}
        </p>
      )}
      <div className="appearance-row mt-3">
        <span className="appearance-label">{zh ? '强调色' : 'Accent color'}</span>
        <div className="appearance-swatch-group" role="group" aria-label={zh ? '强调色' : 'Accent color'}>
          {ACCENTS.map(({ id, name, color }) => {
            const label = glass && id === DEFAULT_ACCENT ? (zh ? '系统蓝' : 'System blue') : zh ? name : id
            const glassAccent = glassAccentTheme(id, resolvedTheme)
            const swatchColor = glass ? glassAccent.solid : color
            return <button key={id} type="button" className="appearance-swatch" title={label} aria-label={label} aria-pressed={accent === id} onClick={() => handleAccentChange(id)} style={{ backgroundColor: swatchColor, backgroundImage: glass ? glassAccentGradient(id, resolvedTheme) : undefined }} />
          })}
        </div>
      </div>
      {!glass && resolvedTheme === 'dark' && <p className="appearance-note">{zh ? '经典配色适用于浅色外观。' : 'Classic accent colors use light appearance.'}</p>}

      {/* 经典外观的侧栏是唯一一块垂直压在窗口底上的结构面，所以「透过」这一项
          只在这里给：液态玻璃外观下侧栏本来就是玻璃，不需要第二个开关。 */}
      {!glass && (
        <section className="appearance-group">
          <h3>{zh ? '侧栏' : 'Sidebar'}</h3>
          <p>
            {zh
              ? '侧栏与主区是并列的，内容不会延到侧栏底下，所以「透过」的东西得另外铺：打开后窗口底上有一层随配色变化的柔光，从半透明的侧栏底下露出来。侧栏的次级文字会同时加深一档 —— 半透明面板压不住原来的灰，对比度得从文字这边补回来。'
              : 'The sidebar sits beside the content and nothing bleeds under it, so the backdrop is laid down separately: a tinted glow on the window floor that shows through the translucent sidebar. Secondary text in the sidebar darkens one step at the same time — a translucent panel cannot hold the original grey, so the contrast is bought back from the text.'}
          </p>
          <label className="appearance-row">
            <span className="flex flex-col gap-1">
              <span className="appearance-label">{zh ? '毛玻璃背景' : 'Frosted background'}</span>
              <span className="appearance-hint">
                {zh
                  ? '侧栏底色转半透明、加一层背景模糊，并把次级文字加深一档。系统要求降低透明度时自动回到实色。'
                  : 'The sidebar turns translucent behind a backdrop blur, with secondary text one step darker. Reverts to opaque when the system asks for reduced transparency.'}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="appearance-switch"
              aria-label={zh ? '侧栏毛玻璃背景' : 'Frosted sidebar background'}
              checked={sidebarFrosted}
              onChange={event => setSidebarFrosted(event.target.checked)}
            />
          </label>
        </section>
      )}

      {glass && <>
        <section className="appearance-group">
          <h3>{zh ? '材质' : 'Material'}</h3>
          <p>
            {zh
              ? '折射由 SVG 位移滤镜实时算出：边缘弯折背景、并沿边缘分离三通道产生色散。参数改动即时生效。'
              : 'Refraction is computed live by an SVG displacement filter: edges bend the backdrop and split its channels for chromatic aberration. Changes apply immediately.'}
          </p>
          <div className="appearance-row">
            <span className="flex flex-col gap-1">
              <span className="appearance-label">{zh ? '折射模式' : 'Refraction mode'}</span>
              <span className="appearance-hint">{REFRACTION_MODES.find(entry => entry.value === mode)?.[zh ? 'hint' : 'hintEn']}</span>
            </span>
            <SegmentedTabs
              semantic="radio"
              ariaLabel={zh ? '折射模式' : 'Refraction mode'}
              value={mode}
              onChange={value => setGlassMode(value as RefractionMode)}
              options={REFRACTION_MODES.map(entry => ({ value: entry.value, label: zh ? entry.label : entry.labelEn }))}
            />
          </div>
          <div className="appearance-tuning-grid">
            <TuningRow
              label={zh ? '折射强度' : 'Refraction'}
              value={refraction}
              display={String(refraction)}
              rangeKey="refraction"
              onChange={value => setGlassTuning({ refraction: value })}
            />
            <TuningRow
              label={zh ? '色散强度' : 'Chromatic aberration'}
              value={aberration}
              display={String(aberration)}
              rangeKey="aberration"
              onChange={value => setGlassTuning({ aberration: value })}
            />
            <TuningRow
              label={zh ? '雾化' : 'Frost'}
              value={frost}
              display={frost.toFixed(2)}
              rangeKey="frost"
              onChange={value => setGlassTuning({ frost: value })}
            />
            <TuningRow
              label={zh ? '弹性' : 'Elasticity'}
              value={elasticity}
              display={elasticity.toFixed(2)}
              rangeKey="elasticity"
              onChange={value => setGlassTuning({ elasticity: value })}
            />
          </div>
          <div className="appearance-row">
            <span className="appearance-hint">
              {zh
                ? '弹性让浮动的玻璃朝指针倾斜拉伸；贴在窗口栏、侧栏上的结构面不受影响，它们必须和所在面板严丝合缝。'
                : 'Elasticity tilts and stretches floating glass toward the pointer. Sheets backing the chrome stay rigid — they have to stay in register with the panel they back.'}
            </span>
            <button
              type="button"
              className="desktop-settings-outline flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-45"
              onClick={resetGlassTuning}
              disabled={!tuningTouched}
            >
              <RotateCcw size={13} />
              {zh ? '恢复默认' : 'Reset'}
            </button>
          </div>
        </section>

        <section className="appearance-group">
          <h3>{zh ? '背景' : 'Backdrop'}</h3>
          <p>
            {zh
              ? '玻璃是折射的介质，本身没有颜色——它的颜色全部来自被它折射的这层背景。'
              : 'Glass is a refractive medium with no colour of its own; everything you see in it comes from the backdrop it bends.'}
          </p>
          <div className="appearance-row">
            <label htmlFor="glass-canvas" className="appearance-label">{zh ? '背景' : 'Backdrop'}</label>
            <select id="glass-canvas" className="appearance-select" value={glassCanvas} onChange={event => setGlassCanvas(event.target.value as 'aurora' | 'neutral')}>
              <option value="aurora">{zh ? '流光' : 'Aurora'}</option>
              <option value="neutral">{zh ? '中性' : 'Neutral'}</option>
            </select>
          </div>
          <label className="appearance-row">
            <span className="flex flex-col gap-1">
              <span className="appearance-label">{zh ? '减少透明效果' : 'Reduce transparency'}</span>
              <span className="appearance-hint">
                {zh ? '玻璃转为实色，不再生成折射图。系统开启了同类偏好时也会自动生效。' : 'Glass becomes opaque and no displacement maps are generated. Applied automatically when the system asks for it.'}
              </span>
            </span>
            <input type="checkbox" role="switch" className="appearance-switch" checked={reduceTransparency} onChange={event => setReduceTransparency(event.target.checked)} />
          </label>
        </section>

        <section className="appearance-group">
          <h3>{zh ? '预览' : 'Preview'}</h3>
          <p>{zh ? '在预览区内移动指针：浮动的玻璃会朝指针倾斜。' : 'Move the pointer inside the preview: floating glass leans toward it.'}</p>
          <AppearancePreview />
        </section>
      </>}
    </div>
  )
}
