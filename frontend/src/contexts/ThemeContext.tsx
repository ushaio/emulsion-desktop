/**
 * ThemeContext 适配器 — 对齐 web 端 useTheme() 接口。
 * 实际主题状态来自 desktop usePreferences。
 *
 * ThemeAppearance 把主题状态写到 <html> 上，分两处消费：
 *
 * - `data-*` 属性：`appearance` / `glassCanvas` / `reduceTransparency` 等开关，
 *   CSS 用属性选择器切换整套材质。注意 `reduceTransparency` 是**合成值**
 *   （应用内开关 OR 系统偏好），另有 `systemReduceTransparency` 只反映系统偏好；
 *   经典外观的侧栏毛玻璃读后者，见 index.css「经典外观：侧栏毛玻璃」。
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
  const { accent, appearance, glassCanvas, reduceTransparency, sidebarFrosted } = usePreferences()
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
    // 只反映**系统**偏好，专给经典外观的侧栏毛玻璃用。上面那个是「应用内开关 OR
    // 系统偏好」的合成值，属于液态玻璃材质；而 .desktop-sidebar 恰好带着 lg-sheet
    // 类，会命中液态玻璃那条「降低透明度 → 结构面转实色」的规则。若侧栏读合成值，
    // 用户在液态玻璃一档里开过一次「减少透明效果」，侧栏毛玻璃就被永久按住，而经典
    // 一档里看不到那个开关 —— 表现就是「开关是开的、侧栏毫无变化」。
    root.dataset.systemReduceTransparency = String(systemReduced)
    // 经典外观的侧栏毛玻璃开关。只被 index.css 里
    // `[data-appearance='classic'][data-sidebar-frosted='true']` 那组规则读取，
    // 液态玻璃外观下写不写都一样。缺省（首帧、属性还没写上）是实色侧栏。
    root.dataset.sidebarFrosted = String(sidebarFrosted)

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
  }, [resolvedTheme, accent, appearance, glassCanvas, reduceTransparency, sidebarFrosted, systemReduced])

  return null
}
