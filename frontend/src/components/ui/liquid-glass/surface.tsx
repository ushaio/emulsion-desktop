/**
 * Desktop bindings for the liquid glass material.
 *
 * `LiquidGlass` is the port itself and takes every value as a prop. These
 * wrappers read the user's tuning from preferences, apply the accessibility
 * gate, and expose the shapes the app actually composes with:
 *
 * - `GlassBackdrop` — a sheet that backs an existing element (`layout="fill"`).
 *   Structural chrome uses this: the element keeps its own layout, focus order
 *   and semantics, and the glass is painted behind it.
 * - `GlassSurface` — a panel that *is* the glass (`layout="block"`).
 * - `GlassButton`, `GlassDock` — floating, elastic, interactive glass.
 *
 * The rule of thumb the theme follows: **structural glass is static, floating
 * glass is elastic.** A sheet backing the sidebar or a toolbar must stay in
 * register with the element it backs, so `layout="fill"` forces elasticity to 0
 * inside `LiquidGlass`. Anything that floats over the page -- dialogs, docks,
 * pills -- keeps the full elastic response.
 */

import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'

import { cn } from '@/lib/utils'
import { usePreferences } from '@/store/preferences'
import { GLASS_DEFAULTS, GLASS_FROST_FACTOR, type GlassTuning } from '@/lib/liquid-glass'
import { LiquidGlass, type LiquidGlassMaterial, type LiquidGlassProps } from './LiquidGlass'

export { LiquidGlass }
export type { LiquidGlassProps, LiquidGlassMaterial } from './LiquidGlass'
export type { RefractionMode } from './LiquidGlass'

const REDUCED_QUERY = '(prefers-reduced-transparency: reduce), (forced-colors: active)'

function subscribeReduced(callback: () => void) {
  const media = window.matchMedia(REDUCED_QUERY)
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}

/**
 * Whether the material should render at all. False whenever the user picked the
 * classic appearance, asked for reduced transparency, or the platform reports a
 * reduced-transparency / forced-colors preference — in which case every glass
 * surface falls back to an opaque sheet painted by styles/liquid-glass.css.
 */
export function useLiquidGlassEnabled() {
  const enabled = usePreferences(state => state.appearance === 'liquid-glass' && !state.reduceTransparency)
  const systemReduced = useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  )
  return enabled && !systemReduced
}

/** The user's tuning, plus whether the material is on. */
export function useGlassTuning(): GlassTuning & { enabled: boolean } {
  const enabled = useLiquidGlassEnabled()
  const mode = usePreferences(state => state.mode)
  const refraction = usePreferences(state => state.refraction)
  const aberration = usePreferences(state => state.aberration)
  const frost = usePreferences(state => state.frost)
  const elasticity = usePreferences(state => state.elasticity)
  return { enabled, mode, refraction, aberration, frost, elasticity }
}

/** Props that carry the user's tuning into a `LiquidGlass` instance. */
function tuningProps(tuning: GlassTuning, material: LiquidGlassMaterial = 'clear') {
  return {
    mode: tuning.mode,
    // Defaults from lib/liquid-glass.ts mirror the port's own, so a store that
    // somehow lost the keys still yields the shipped look.
    displacementScale: tuning.refraction ?? GLASS_DEFAULTS.refraction,
    blurAmount: (tuning.frost ?? GLASS_DEFAULTS.frost) * GLASS_FROST_FACTOR[material],
    aberrationIntensity: tuning.aberration ?? GLASS_DEFAULTS.aberration,
    elasticity: tuning.elasticity ?? GLASS_DEFAULTS.elasticity,
  }
}

export interface GlassBackdropProps {
  material?: LiquidGlassMaterial
  className?: string
  /** Skip the opacity/visibility checks when the caller already gated. */
  force?: boolean
}

/**
 * A decorative sheet that fills its (positioned) parent and paints behind its
 * content. Renders nothing when the material is off.
 */
export function GlassBackdrop({ material = 'clear', className, force = false }: GlassBackdropProps) {
  const tuning = useGlassTuning()
  if (!tuning.enabled && !force) return null
  return (
    <LiquidGlass
      layout="fill"
      aria-hidden="true"
      enabled={tuning.enabled}
      material={material}
      className={cn('lg-backdrop', className)}
      {...tuningProps(tuning, material)}
    />
  )
}

export interface GlassSurfaceProps extends Omit<LiquidGlassProps, 'layout' | 'enabled' | 'material'> {
  children?: ReactNode
  material?: LiquidGlassMaterial
}

/**
 * A glass panel. Use this where the surface is the component — dialogs, cards,
 * floating panels — rather than a backdrop behind other markup.
 */
export function GlassSurface({
  children,
  className,
  material = 'regular',
  cornerRadius = 16,
  padding = '20px',
  ...rest
}: GlassSurfaceProps) {
  const tuning = useGlassTuning()
  return (
    <LiquidGlass
      layout="block"
      enabled={tuning.enabled}
      material={material}
      cornerRadius={cornerRadius}
      padding={padding}
      className={cn('lg-surface', className)}
      {...tuningProps(tuning, material)}
      {...rest}
    >
      {children}
    </LiquidGlass>
  )
}

export interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary'
}

/**
 * A real `<button>` with a glass sheet behind it. The sheet is decorative, so
 * the button keeps its own semantics, focus ring and disabled state.
 */
export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton(
  { children, className, variant = 'default', type = 'button', disabled, ...props },
  ref,
) {
  const tuning = useGlassTuning()
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={disabled}
      className={cn('lg-button', className)}
      data-variant={variant}
      data-disabled={disabled || undefined}
      data-slot="glass-button"
    >
      <LiquidGlass
        layout="fill"
        enabled={tuning.enabled}
        material={variant === 'primary' ? 'regular' : 'clear'}
        aria-hidden="true"
        className="lg-button__glass"
        {...tuningProps(tuning, variant === 'primary' ? 'regular' : 'clear')}
      />
      <span className="lg-button__label">{children}</span>
    </button>
  )
})

export interface DockIcon {
  src?: string
  icon?: ReactNode
  alt: string
  onClick?: () => void
  active?: boolean
}

/** A floating pill of icon actions. Individual icons light up on selection. */
export function GlassDock({ icons, className, style }: { icons: DockIcon[]; className?: string; style?: CSSProperties }) {
  const tuning = useGlassTuning()
  return (
    <LiquidGlass
      enabled={tuning.enabled}
      material="regular"
      cornerRadius={999}
      padding="5px"
      className={cn('lg-dock', className)}
      style={style}
      {...tuningProps(tuning, 'regular')}
    >
      <div className="lg-dock__items" role="group">
        {icons.map(({ src, icon, alt, onClick, active }) => (
          <button
            key={alt}
            type="button"
            onClick={onClick}
            aria-label={alt}
            title={alt}
            aria-pressed={active}
            className="lg-dock__item"
          >
            {src ? <img src={src} alt="" draggable={false} /> : icon}
          </button>
        ))}
      </div>
    </LiquidGlass>
  )
}
