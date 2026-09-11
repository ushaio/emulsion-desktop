/**
 * ThemeContext 适配器 — 对齐 web 端 useTheme() 接口。
 * 实际主题状态来自 desktop usePreferences。
 *
 * ThemeAppearance 把主题状态写到 <html> 上，分两处消费：
 *
 * - `data-*` 属性：`appearance` / `glassCanvas` / `reduceTransparency` 等开关，
 *   CSS 用属性选择器切换整套材质。
 * - `--lg-*` 变量：强调色族。配色在 JS 里定义（lib/accents.ts），
 *   **构图在 CSS 里**（styles/liquid-glass.css 只按位置摆放光源，不关心颜色），
 *   所以换配色只改这些变量，背景光幕与玻璃受光的形状不变。
 *
 * 选择器那半边的具体度要求写在 liquid-glass.css 里，改动前请先读那里的说明。
 */
import { usePreferences } from '@/store/preferences'
import { useLayoutEffect, useSyncExternalStore } from 'react'
import { glassAccentTheme, DEFAULT_ACCENT } from '@/lib/accents'

function subscribeSystemTheme(callback: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}

export function useTheme() {
  const { theme } = usePreferences()
  const systemTheme = useSyncExternalStore<'light' | 'dark'>(
    subscribeSystemTheme,
    () => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    () => 'light',
  )
  const resolvedTheme = theme === 'system' ? systemTheme : theme

  return { theme, resolvedTheme }
}

function subscribeTransparency(callback: () => void) {
  const media = window.matchMedia('(prefers-reduced-transparency: reduce)')
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}

export function ThemeAppearance() {
  const { resolvedTheme } = useTheme()
  const { accent, appearance, glassCanvas, reduceTransparency } = usePreferences()
  const systemReduced = useSyncExternalStore(subscribeTransparency,
    () => window.matchMedia('(prefers-reduced-transparency: reduce)').matches, () => false)

  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.classList.toggle('light', resolvedTheme === 'light')
    root.dataset.accent = accent
    root.dataset.appearance = appearance
    root.dataset.glassCanvas = glassCanvas
    root.dataset.reduceTransparency = String(reduceTransparency || systemReduced)

    const glass = glassAccentTheme(accent ?? DEFAULT_ACCENT, resolvedTheme)
    const [aurora1, aurora2, aurora3] = glass.aurora
    const [gradientFrom, gradientTo] = glass.gradient
    const target = root.style
    target.setProperty('--lg-accent', glass.solid)
    target.setProperty('--lg-accent-gradient', `linear-gradient(135deg, ${gradientFrom}, ${gradientTo})`)
    target.setProperty('--lg-accent-from', gradientFrom)
    target.setProperty('--lg-accent-to', gradientTo)
    target.setProperty('--lg-aurora-1', aurora1)
    target.setProperty('--lg-aurora-2', aurora2)
    target.setProperty('--lg-aurora-3', aurora3)
    target.setProperty('--lg-rim-tint', glass.rim)
    target.setProperty('--lg-glow', glass.glow)
  }, [resolvedTheme, accent, appearance, glassCanvas, reduceTransparency, systemReduced])

  return null
}
