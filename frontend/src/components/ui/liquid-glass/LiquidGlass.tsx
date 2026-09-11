/**
 * Liquid glass material.
 *
 * Ported from liquid-glass-react (`.ui/liquid-glass-react/src/index.tsx`, MIT).
 * The SVG refraction filter (edge mask, three-channel displacement, screen
 * blend for chromatic aberration), the backdrop warp layer, the mouse-reactive
 * rim gradient, and the elastic transform keep the upstream algorithm and its
 * numeric constants.
 *
 * Adaptations, each marked ADAPTATION below, make it usable as a whole-application
 * material rather than a demo pill:
 *
 *  1. `layout` (inline / block / fill). Upstream only ever renders a centred
 *     pill. `fill` in particular is what lets the material back an existing
 *     element without touching its layout.
 *  2. `anchor="center"` reproduces upstream's implicit centring; the desktop
 *     default is `flow`, so glass sits in normal layout.
 *  3. Decoration layers are absolutely positioned against the glass box. Upstream
 *     borrows the caller's positioning, so its rim spans -- plain inline spans --
 *     collapse to zero size unless the caller passes `position: absolute`.
 *  4. Content colour, typography and shadow are tokenised instead of hardcoded
 *     white on system-ui, so the material can host app text.
 *  5. `enabled` honours reduced-transparency and forced-colors preferences.
 *  6. `mode="shader"` bounds and caches its generated texture so large surfaces
 *     do not block the main thread.
 *  7. Sizing tracks a ResizeObserver instead of mount + window resize, so panels
 *     that resize on their own stay in register.
 */

import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import { cn } from '@/lib/utils'
import type { RefractionMode } from '@/lib/liquid-glass'
import { displacementMap, polarDisplacementMap, prominentDisplacementMap } from './maps'
import { ShaderDisplacementGenerator, fragmentShaders } from './shader-utils'

export type { RefractionMode }

/** Upstream generates the shader map at element resolution; cap it. */
const MAX_SHADER_TEXTURE = 480
const MAX_CACHED_SHADER_MAPS = 24
const shaderMapCache = new Map<string, string>()

const IS_FIREFOX =
  typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')

function generateShaderDisplacementMap(width: number, height: number): string {
  // The lens is evaluated in UV space, so a proportionally smaller texture
  // stretches back over the element without changing the shape of the field.
  const scale = Math.min(1, MAX_SHADER_TEXTURE / Math.max(width, height))
  const mapWidth = Math.max(2, Math.round(width * scale))
  const mapHeight = Math.max(2, Math.round(height * scale))
  const cacheKey = `${mapWidth}:${mapHeight}`
  const cached = shaderMapCache.get(cacheKey)
  if (cached !== undefined) return cached

  const generator = new ShaderDisplacementGenerator({
    width: mapWidth,
    height: mapHeight,
    fragment: fragmentShaders.liquidGlass,
  })
  const dataUrl = generator.updateShader()
  generator.destroy()

  if (shaderMapCache.size >= MAX_CACHED_SHADER_MAPS) {
    shaderMapCache.delete(shaderMapCache.keys().next().value as string)
  }
  shaderMapCache.set(cacheKey, dataUrl)
  return dataUrl
}

function getMap(mode: RefractionMode, shaderMapUrl?: string) {
  switch (mode) {
    case 'standard':
      return displacementMap
    case 'polar':
      return polarDisplacementMap
    case 'prominent':
      return prominentDisplacementMap
    case 'shader':
      return shaderMapUrl || displacementMap
  }
}

/* ---------- SVG filter (edge-only displacement) ---------- */

interface GlassFilterProps {
  id: string
  displacementScale: number
  aberrationIntensity: number
  mode: RefractionMode
  shaderMapUrl?: string
}

const GlassFilter = ({ id, displacementScale, aberrationIntensity, mode, shaderMapUrl }: GlassFilterProps) => (
  // ADAPTATION 7: sized to nothing and kept out of layout. It paints only
  // <defs>, so the reference from the warp layer still resolves while the node
  // cannot affect flow, overflow or hit testing.
  <svg className="liquid-glass__filter pointer-events-none absolute size-0 overflow-hidden" aria-hidden="true">
    <defs>
      <radialGradient id={`${id}-edge-mask`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="black" stopOpacity="0" />
        <stop offset={`${Math.max(30, 80 - aberrationIntensity * 2)}%`} stopColor="black" stopOpacity="0" />
        <stop offset="100%" stopColor="white" stopOpacity="1" />
      </radialGradient>
      <filter id={id} x="-35%" y="-35%" width="170%" height="170%" colorInterpolationFilters="sRGB">
        <feImage
          id={`${id}-feimage`}
          x="0"
          y="0"
          width="100%"
          height="100%"
          result="DISPLACEMENT_MAP"
          href={getMap(mode, shaderMapUrl)}
          preserveAspectRatio="xMidYMid slice"
        />

        {/* Create edge mask using the displacement map itself */}
        <feColorMatrix
          in="DISPLACEMENT_MAP"
          type="matrix"
          values="0.3 0.3 0.3 0 0
                 0.3 0.3 0.3 0 0
                 0.3 0.3 0.3 0 0
                 0 0 0 1 0"
          result="EDGE_INTENSITY"
        />
        <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
          <feFuncA type="discrete" tableValues={`0 ${aberrationIntensity * 0.05} 1`} />
        </feComponentTransfer>

        {/* Original undisplaced image for center */}
        <feOffset in="SourceGraphic" dx="0" dy="0" result="CENTER_ORIGINAL" />

        {/* Red channel displacement with slight offset */}
        <feDisplacementMap
          in="SourceGraphic"
          in2="DISPLACEMENT_MAP"
          scale={displacementScale * (mode === 'shader' ? 1 : -1)}
          xChannelSelector="R"
          yChannelSelector="B"
          result="RED_DISPLACED"
        />
        <feColorMatrix
          in="RED_DISPLACED"
          type="matrix"
          values="1 0 0 0 0
                 0 0 0 0 0
                 0 0 0 0 0
                 0 0 0 1 0"
          result="RED_CHANNEL"
        />

        {/* Green channel displacement */}
        <feDisplacementMap
          in="SourceGraphic"
          in2="DISPLACEMENT_MAP"
          scale={displacementScale * ((mode === 'shader' ? 1 : -1) - aberrationIntensity * 0.05)}
          xChannelSelector="R"
          yChannelSelector="B"
          result="GREEN_DISPLACED"
        />
        <feColorMatrix
          in="GREEN_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                 0 1 0 0 0
                 0 0 0 0 0
                 0 0 0 1 0"
          result="GREEN_CHANNEL"
        />

        {/* Blue channel displacement with slight offset */}
        <feDisplacementMap
          in="SourceGraphic"
          in2="DISPLACEMENT_MAP"
          scale={displacementScale * ((mode === 'shader' ? 1 : -1) - aberrationIntensity * 0.1)}
          xChannelSelector="R"
          yChannelSelector="B"
          result="BLUE_DISPLACED"
        />
        <feColorMatrix
          in="BLUE_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                 0 0 0 0 0
                 0 0 1 0 0
                 0 0 0 1 0"
          result="BLUE_CHANNEL"
        />

        {/* Combine all channels with screen blend mode for chromatic aberration */}
        <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
        <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />

        {/* Add slight blur to soften the aberration effect */}
        <feGaussianBlur
          in="RGB_COMBINED"
          stdDeviation={Math.max(0.1, 0.5 - aberrationIntensity * 0.1)}
          result="ABERRATED_BLURRED"
        />

        {/* Apply edge mask to aberration effect */}
        <feComposite in="ABERRATED_BLURRED" in2="EDGE_MASK" operator="in" result="EDGE_ABERRATION" />

        {/* Create inverted mask for center */}
        <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
          <feFuncA type="table" tableValues="1 0" />
        </feComponentTransfer>
        <feComposite in="CENTER_ORIGINAL" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />

        {/* Combine edge aberration with clean center */}
        <feComposite in="EDGE_ABERRATION" in2="CENTER_CLEAN" operator="over" />
      </filter>
    </defs>
  </svg>
)

export type LiquidGlassLayout = 'inline' | 'block' | 'fill'
export type LiquidGlassMaterial = 'clear' | 'regular'
export type LiquidGlassAnchor = 'flow' | 'center'

export interface LiquidGlassProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'children'> {
  children?: ReactNode
  /** Refraction strength of the SVG displacement filter. */
  displacementScale?: number
  /** Frost. Feeds `blur(${(overLight ? 12 : 4) + blurAmount * 32}px)` exactly as upstream. */
  blurAmount?: number
  /** Backdrop saturation percentage. */
  saturation?: number
  /** Chromatic aberration intensity (also widens the refractive edge). */
  aberrationIntensity?: number
  /** How far the glass leans toward the pointer. 0 pins it in place. */
  elasticity?: number
  cornerRadius?: number
  padding?: string
  /** Tints the glass dark for bright backdrops, as upstream. */
  overLight?: boolean
  mode?: RefractionMode
  /** ADAPTATION 1: box model of the sheet. */
  layout?: LiquidGlassLayout
  /** ADAPTATION 2: `center` matches upstream's implicit centring. */
  anchor?: LiquidGlassAnchor
  /** Track the pointer on a larger element so the glass can reach toward it. */
  mouseContainer?: React.RefObject<HTMLElement | null> | null
  /** ADAPTATION 5: false paints an opaque sheet instead of a refractive one. */
  enabled?: boolean
  /** Pressed state when the caller owns it; combined with internal pointer state. */
  active?: boolean
  /** `regular` frosts more heavily -- the tint and blur of a panel, not a lens. */
  material?: LiquidGlassMaterial
  className?: string
  contentClassName?: string
  contentStyle?: CSSProperties
  onClick?: () => void
}

export const LiquidGlass = forwardRef<HTMLDivElement, LiquidGlassProps>(function LiquidGlass(
  {
    children,
    displacementScale = 70,
    blurAmount = 0.0625,
    saturation = 140,
    aberrationIntensity = 2,
    elasticity = 0.15,
    cornerRadius = 999,
    padding = '24px 32px',
    overLight = false,
    mode = 'standard',
    layout = 'inline',
    anchor = 'flow',
    mouseContainer = null,
    enabled = true,
    active: externallyActive = false,
    material = 'clear',
    className,
    contentClassName,
    contentStyle,
    style,
    onClick,
    ...props
  },
  ref,
) {
  const rawId = useId()
  const filterId = useMemo(() => `liquid-glass-filter-${rawId.replace(/:/g, '')}`, [rawId])
  const glassRef = useRef<HTMLDivElement | null>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isActive, setIsActive] = useState(false)
  const [glassSize, setGlassSize] = useState({ width: 270, height: 69 })
  const [internalGlobalMousePos, setInternalGlobalMousePos] = useState({ x: 0, y: 0 })
  const [internalMouseOffset, setInternalMouseOffset] = useState({ x: 0, y: 0 })
  const [shaderMapUrl, setShaderMapUrl] = useState('')

  const isFill = layout === 'fill'
  // A sheet that fills a structural surface must stay in register with it, so
  // elasticity is a floating-glass affordance only.
  const effectiveElasticity = isFill ? 0 : elasticity
  const interactive = Boolean(onClick)
  const isActiveResolved = isActive || externallyActive

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      glassRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  // ADAPTATION 6: the shader lens only has to be generated when it is in use.
  useEffect(() => {
    if (!enabled || mode !== 'shader' || !glassSize.width || !glassSize.height) return
    setShaderMapUrl(generateShaderDisplacementMap(glassSize.width, glassSize.height))
  }, [enabled, mode, glassSize.width, glassSize.height])

  // ADAPTATION 7: measure the box that the sheet actually covers.
  useEffect(() => {
    const el = glassRef.current
    if (!el || !enabled) return
    let frame = 0
    const measure = () => {
      const target = isFill ? (el.parentElement ?? el) : el
      const width = target.offsetWidth
      const height = target.offsetHeight
      if (!width || !height) return
      setGlassSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }))
    }
    measure()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(el)
    if (isFill && el.parentElement) observer.observe(el.parentElement)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
    }
  }, [enabled, isFill])

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const container = mouseContainer?.current || glassRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      setInternalMouseOffset({
        x: ((e.clientX - centerX) / rect.width) * 100,
        y: ((e.clientY - centerY) / rect.height) * 100,
      })
      setInternalGlobalMousePos({ x: e.clientX, y: e.clientY })
    },
    [mouseContainer],
  )

  useEffect(() => {
    if (!enabled || isFill) return
    const container = mouseContainer?.current || glassRef.current
    if (!container) return
    container.addEventListener('mousemove', handleMouseMove)
    return () => container.removeEventListener('mousemove', handleMouseMove)
  }, [enabled, handleMouseMove, mouseContainer, isFill])

  const globalMousePos = internalGlobalMousePos
  const mouseOffset = internalMouseOffset

  // Calculate directional scaling based on mouse position
  const calculateDirectionalScale = useCallback(() => {
    if (!globalMousePos.x || !globalMousePos.y || !glassRef.current || !effectiveElasticity) return 'scale(1)'

    const rect = glassRef.current.getBoundingClientRect()
    const pillCenterX = rect.left + rect.width / 2
    const pillCenterY = rect.top + rect.height / 2
    const pillWidth = glassSize.width
    const pillHeight = glassSize.height

    const deltaX = globalMousePos.x - pillCenterX
    const deltaY = globalMousePos.y - pillCenterY

    // Distance from the pointer to the pill's edges, not its centre.
    const edgeDistanceX = Math.max(0, Math.abs(deltaX) - pillWidth / 2)
    const edgeDistanceY = Math.max(0, Math.abs(deltaY) - pillHeight / 2)
    const edgeDistance = Math.sqrt(edgeDistanceX * edgeDistanceX + edgeDistanceY * edgeDistanceY)

    const activationZone = 200
    if (edgeDistance > activationZone) return 'scale(1)'

    const fadeInFactor = 1 - edgeDistance / activationZone
    const centerDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)
    if (centerDistance === 0) return 'scale(1)'

    const normalizedX = deltaX / centerDistance
    const normalizedY = deltaY / centerDistance
    const stretchIntensity = Math.min(centerDistance / 300, 1) * effectiveElasticity * fadeInFactor

    const scaleX = 1 + Math.abs(normalizedX) * stretchIntensity * 0.3 - Math.abs(normalizedY) * stretchIntensity * 0.15
    const scaleY = 1 + Math.abs(normalizedY) * stretchIntensity * 0.3 - Math.abs(normalizedX) * stretchIntensity * 0.15

    return `scaleX(${Math.max(0.8, scaleX)}) scaleY(${Math.max(0.8, scaleY)})`
  }, [globalMousePos, effectiveElasticity, glassSize])

  const calculateFadeInFactor = useCallback(() => {
    if (!globalMousePos.x || !globalMousePos.y || !glassRef.current) return 0

    const rect = glassRef.current.getBoundingClientRect()
    const pillCenterX = rect.left + rect.width / 2
    const pillCenterY = rect.top + rect.height / 2
    const pillWidth = glassSize.width
    const pillHeight = glassSize.height

    const edgeDistanceX = Math.max(0, Math.abs(globalMousePos.x - pillCenterX) - pillWidth / 2)
    const edgeDistanceY = Math.max(0, Math.abs(globalMousePos.y - pillCenterY) - pillHeight / 2)
    const edgeDistance = Math.sqrt(edgeDistanceX * edgeDistanceX + edgeDistanceY * edgeDistanceY)

    const activationZone = 200
    return edgeDistance > activationZone ? 0 : 1 - edgeDistance / activationZone
  }, [globalMousePos, glassSize])

  const calculateElasticTranslation = useCallback(() => {
    if (!glassRef.current || !effectiveElasticity) return { x: 0, y: 0 }

    const fadeInFactor = calculateFadeInFactor()
    const rect = glassRef.current.getBoundingClientRect()
    const pillCenterX = rect.left + rect.width / 2
    const pillCenterY = rect.top + rect.height / 2

    return {
      x: (globalMousePos.x - pillCenterX) * effectiveElasticity * 0.1 * fadeInFactor,
      y: (globalMousePos.y - pillCenterY) * effectiveElasticity * 0.1 * fadeInFactor,
    }
  }, [globalMousePos, effectiveElasticity, calculateFadeInFactor])

  const anchorTranslate = anchor === 'center' ? 'translate(-50%, -50%) ' : ''
  const elastic = calculateElasticTranslation()
  const transformStyle = `${anchorTranslate}translate(${elastic.x}px, ${elastic.y}px) ${isActiveResolved && interactive ? 'scale(0.96)' : calculateDirectionalScale()}`

  const refractionActive = enabled && !IS_FIREFOX
  const backdropStyle: CSSProperties = enabled
    ? {
        ...(refractionActive ? { filter: `url(#${filterId})` } : null),
        backdropFilter: `blur(${(overLight ? 12 : 4) + blurAmount * 32}px) saturate(${saturation}%)`,
        WebkitBackdropFilter: `blur(${(overLight ? 12 : 4) + blurAmount * 32}px) saturate(${saturation}%)`,
      }
    : {}

  const rootStyle: CSSProperties = {
    ...style,
    ...(anchor === 'center' ? { position: style?.position ?? 'absolute', top: style?.top ?? '50%', left: style?.left ?? '50%' } : null),
    ...(isFill ? { position: style?.position ?? 'absolute', inset: style?.inset ?? 0, pointerEvents: 'none' } : null),
  }

  const layerStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    height: glassSize.height,
    width: glassSize.width,
    borderRadius: `${cornerRadius}px`,
    pointerEvents: 'none',
  }

  // The gradient sweeps with the pointer, so the rim catches the light the way
  // Apple's does. Opacities and angles are upstream's.
  const rimGradient = (peakA: number, peakB: number) =>
    `linear-gradient(
      ${135 + mouseOffset.x * 1.2}deg,
      rgba(255, 255, 255, 0.0) 0%,
      rgba(255, 255, 255, ${peakA + Math.abs(mouseOffset.x) * 0.008}) ${Math.max(10, 33 + mouseOffset.y * 0.3)}%,
      rgba(255, 255, 255, ${peakB + Math.abs(mouseOffset.x) * 0.012}) ${Math.min(90, 66 + mouseOffset.y * 0.4)}%,
      rgba(255, 255, 255, 0.0) 100%
    )`

  const rimBoxShadow =
    '0 0 0 0.5px rgba(255, 255, 255, 0.5) inset, 0 1px 3px rgba(255, 255, 255, 0.25) inset, 0 1px 4px rgba(0, 0, 0, 0.35)'

  const rimMask: CSSProperties = {
    padding: '1.5px',
    WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    WebkitMaskComposite: 'xor',
    maskComposite: 'exclude',
  }

  return (
    <div
      ref={setRefs}
      className={cn(
        'liquid-glass',
        isFill && 'liquid-glass--fill',
        className,
      )}
      style={rootStyle}
      data-layout={layout}
      data-material={material}
      data-over-light={overLight ? 'true' : undefined}
      data-refraction={refractionActive ? 'active' : 'fallback'}
      data-interactive={interactive ? 'true' : undefined}
      data-glass-enabled={enabled ? 'true' : 'false'}
      {...props}
    >
      {refractionActive && (
        <GlassFilter
          id={filterId}
          displacementScale={overLight ? displacementScale * 0.5 : displacementScale}
          aberrationIntensity={aberrationIntensity}
          mode={mode}
          shaderMapUrl={shaderMapUrl}
        />
      )}

      {/* Everything that must move together lives on one transformed layer, so
          the rim can never drift out of register with the sheet. */}
      <div
        className="liquid-glass__transform"
        style={{
          position: isFill ? 'absolute' : 'relative',
          ...(isFill ? { inset: 0 } : null),
          borderRadius: `${cornerRadius}px`,
          transform: transformStyle,
          transition: 'all ease-out 0.2s',
        }}
      >
        {/* ADAPTATION 3: upstream leans on the caller's `position` for these
            black plates; anchored here they always sit behind the sheet. */}
        {overLight && (
          <>
            <div className="liquid-glass__over-light liquid-glass__over-light--tint" style={{ ...layerStyle, backgroundColor: '#000' }} />
            <div className="liquid-glass__over-light liquid-glass__over-light--blend" style={{ ...layerStyle, backgroundColor: '#000' }} />
          </>
        )}

        <div
          className="liquid-glass__box"
          style={{
            position: isFill ? 'absolute' : 'relative',
            ...(isFill ? { inset: 0 } : null),
            borderRadius: `${cornerRadius}px`,
            padding: isFill ? 0 : padding,
            display: 'flex',
            flexDirection: layout === 'block' ? 'column' : 'row',
            alignItems: layout === 'inline' ? 'center' : 'stretch',
            gap: layout === 'inline' ? 24 : 0,
            overflow: 'var(--lg-overflow, hidden)',
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onMouseDown={() => setIsActive(true)}
          onMouseUp={() => setIsActive(false)}
          onClick={onClick}
        >
          {/* backdrop layer that gets wiggly */}
          <span className="liquid-glass__warp" style={{ ...backdropStyle, position: 'absolute', inset: 0 }} />

          {/* user content stays sharp */}
          <div className={cn('liquid-glass__content', contentClassName)} style={contentStyle}>
            {children}
          </div>
        </div>

        {/* Border layer 1 -- extracted from glass container */}
        <span
          aria-hidden="true"
          className="liquid-glass__rim liquid-glass__rim--screen"
          style={{
            ...layerStyle,
            ...rimMask,
            mixBlendMode: 'screen',
            opacity: 'var(--lg-rim-opacity, 0.2)',
            boxShadow: rimBoxShadow,
            background: rimGradient(0.12, 0.4),
          }}
        />

        {/* Border layer 2 -- duplicate with mix-blend-overlay */}
        <span
          aria-hidden="true"
          className="liquid-glass__rim liquid-glass__rim--overlay"
          style={{
            ...layerStyle,
            ...rimMask,
            mixBlendMode: 'overlay',
            opacity: 'var(--lg-rim-opacity-strong, 1)',
            boxShadow: rimBoxShadow,
            background: rimGradient(0.32, 0.6),
          }}
        />

        {/* Hover effects */}
        {interactive && (
          <>
            <div
              aria-hidden="true"
              style={{
                ...layerStyle,
                width: glassSize.width + 1,
                transition: 'all 0.2s ease-out',
                opacity: isHovered || isActiveResolved ? 0.5 : 0,
                backgroundImage: 'radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0) 50%)',
                mixBlendMode: 'overlay',
              }}
            />
            <div
              aria-hidden="true"
              style={{
                ...layerStyle,
                width: glassSize.width + 1,
                transition: 'all 0.2s ease-out',
                opacity: isActiveResolved ? 0.5 : 0,
                backgroundImage: 'radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0) 80%)',
                mixBlendMode: 'overlay',
              }}
            />
            <div
              aria-hidden="true"
              style={{
                ...layerStyle,
                width: glassSize.width + 1,
                transition: 'all 0.2s ease-out',
                opacity: isHovered ? 0.4 : isActiveResolved ? 0.8 : 0,
                backgroundImage: 'radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0) 100%)',
                mixBlendMode: 'overlay',
              }}
            />
          </>
        )}
      </div>
    </div>
  )
})

export default LiquidGlass
