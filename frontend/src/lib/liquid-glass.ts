/**
 * Liquid glass tuning: the knobs the appearance settings expose, their ranges,
 * and the defaults the material ships with.
 *
 * These live outside the component so the preferences store, the appearance
 * panel, and the material itself can share one source of truth without a
 * component -> store -> component import cycle.
 *
 * Defaults are liquid-glass-react's own (`.ui/liquid-glass-react/src/index.tsx`):
 * `displacementScale` 70, `blurAmount` 0.0625, `aberrationIntensity` 2,
 * `elasticity` 0.15.
 */

export type RefractionMode = 'standard' | 'polar' | 'prominent' | 'shader'

/** How the backdrop is painted behind floating glass. */
export type GlassCanvas = 'aurora' | 'neutral'

export interface GlassTuning {
  mode: RefractionMode
  /** `displacementScale` — how far the edge bends the backdrop. */
  refraction: number
  /** `aberrationIntensity` — RGB channel separation at the rim. */
  aberration: number
  /** `blurAmount` — frost. */
  frost: number
  /** `elasticity` — how far floating glass leans toward the pointer. */
  elasticity: number
}

export const GLASS_DEFAULTS: GlassTuning = {
  mode: 'standard',
  refraction: 70,
  // Divergence from upstream's 0.0625: the desktop uses the material for
  // structural panels and dialog bodies, not only for floating pills over a
  // photograph. 0.25 is `blur(12px)` once the port's formula is applied, which
  // is what makes app text legible over the light field. The slider reaches
  // upstream's value if a user wants the thinner sheet.
  frost: 0.25,
  aberration: 2,
  elasticity: 0.15,
}

/**
 * Frost multiplier per material. `regular` panels take the tuned frost as-is;
 * `clear` lenses (buttons, the segmented lens, the dock) take half, because a
 * 12px blur on a 34px-tall pill reads as fog rather than glass.
 */
export const GLASS_FROST_FACTOR = { clear: 0.5, regular: 1 } as const

export const REFRACTION_MODES: readonly {
  value: RefractionMode
  label: string
  labelEn: string
  hint: string
  hintEn: string
}[] = [
  { value: 'standard', label: '标准', labelEn: 'Standard', hint: '预烘焙折射图，开销最低', hintEn: 'Pre-baked map, cheapest' },
  { value: 'polar', label: '极向', labelEn: 'Polar', hint: '向中心收束的折射', hintEn: 'Refraction pulled toward the centre' },
  { value: 'prominent', label: '强烈', labelEn: 'Prominent', hint: '边缘折射更重、更厚', hintEn: 'Heavier, thicker edge bend' },
  { value: 'shader', label: '着色器', labelEn: 'Shader', hint: '按元素尺寸实时生成，最准也最耗', hintEn: 'Generated per size: most accurate, most costly' },
]

/** Slider bounds, matching the ranges liquid-glass-react's own playground uses. */
export const GLASS_RANGES = {
  refraction: { min: 0, max: 200, step: 1 },
  aberration: { min: 0, max: 20, step: 1 },
  frost: { min: 0, max: 1, step: 0.01 },
  elasticity: { min: 0, max: 1, step: 0.05 },
} as const

/**
 * Tuning is persisted, so it outlives the UI that wrote it. Anything missing or
 * out of range -- an older save, a hand-edited value -- falls back rather than
 * reaching the filter, where a bad number is a blank or a black sheet.
 */
export function normalizeTuning(input: Partial<GlassTuning> | undefined): GlassTuning {
  const raw = input ?? {}
  const mode = REFRACTION_MODES.some(entry => entry.value === raw.mode) ? raw.mode! : GLASS_DEFAULTS.mode
  return {
    mode,
    refraction: clamp(raw.refraction, GLASS_RANGES.refraction, GLASS_DEFAULTS.refraction),
    aberration: clamp(raw.aberration, GLASS_RANGES.aberration, GLASS_DEFAULTS.aberration),
    frost: clamp(raw.frost, GLASS_RANGES.frost, GLASS_DEFAULTS.frost),
    elasticity: clamp(raw.elasticity, GLASS_RANGES.elasticity, GLASS_DEFAULTS.elasticity),
  }
}

function clamp(
  value: number | undefined,
  range: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, value))
}
