/**
 * 配色方案（Accent）— 以胶片品牌命名，与产品 Emulsion（胶片乳剂）呼应。
 *
 * 两套模型并存，由「主题风格」决定使用哪一套：
 *
 * - `ACCENTS` 是经典外观的配色，只影响主按钮、导航选中态、开关、焦点环等；
 *   状态色（成功/警告/危险）不随配色变化，保持语义稳定。
 * - `GLASS_ACCENTS` 是液态玻璃外观的配色。玻璃本身没有颜色 —— 它是折射和模糊
 *   的介质，颜色全部来自被它折射的那层「光幕」背景。所以这里描述的不是控件
 *   着色，而是**背景光源与材质受光**：
 *     - `aurora`：三处光源的颜色，由 ThemeContext 写入 `--lg-aurora-1..3`，
 *       背景光幕的几何形状在 styles/liquid-glass.css 里，改配色只改颜色不动构图。
 *     - `solid` / `gradient`：需要实色填充时的强调色（主按钮、选中态）。
 *     - `rim` / `glow`：玻璃边缘的受光色与投影色。
 *
 * 两套模型都以品牌名索引，`DEFAULT_ACCENT` 是默认值。液态玻璃下它的 `solid`
 * 是系统蓝而非近黑 —— 玻璃上的强调色需要真正的色相才能被折射出来。
 */
export const ACCENTS = [
  { id: 'silver', name: '银盐', color: '#18181b' },
  { id: 'kodak', name: '柯达', color: '#c9860a' },
  { id: 'fuji', name: '富士', color: '#0f7a5c' },
  { id: 'agfa', name: '爱克发', color: '#c2410c' },
  { id: 'ilford', name: '依尔福', color: '#3b5b8a' },
  { id: 'polaroid', name: '宝丽来', color: '#5b5bd6' },
  { id: 'sakura', name: '樱花', color: '#c2497a' },
] as const

export type AccentId = (typeof ACCENTS)[number]['id']

export const DEFAULT_ACCENT: AccentId = 'silver'

export interface GlassAccentTheme {
  /** 实色强调色：文字、图标、选中态。需在该外观下可读。 */
  solid: string
  /**
   * 实色填充控件的渐变两端。同一外观下两端亮度对齐在同一档，
   * 因此渐变横跨整个控件时与 `--primary-foreground` 的对比度仍然达标。
   */
  gradient: readonly [string, string]
  /** 背景光幕的三处光源，按 1→3 叠放。带 alpha，深浅由外观决定。 */
  aurora: readonly [string, string, string]
  /** 玻璃上边缘的受光色。 */
  rim: string
  /** 强调色投影。 */
  glow: string
}

export const GLASS_ACCENTS: Record<AccentId, { light: GlassAccentTheme; dark: GlassAccentTheme }> = {
  silver: {
    light: {
      solid: '#0a63d6',
      gradient: ['#0a63d6', '#5b4bd6'],
      aurora: ['rgb(0 122 255 / 0.5)', 'rgb(122 92 255 / 0.46)', 'rgb(255 92 168 / 0.36)'],
      rim: 'rgb(255 255 255 / 0.85)',
      glow: 'rgb(10 99 214 / 0.3)',
    },
    dark: {
      solid: '#7cc2ff',
      gradient: ['#3d9bff', '#7a6bff'],
      aurora: ['rgb(10 132 255 / 0.55)', 'rgb(120 90 255 / 0.45)', 'rgb(255 55 95 / 0.3)'],
      rim: 'rgb(255 255 255 / 0.5)',
      glow: 'rgb(61 155 255 / 0.32)',
    },
  },
  kodak: {
    light: {
      solid: '#9a5b00',
      gradient: ['#a35c00', '#c2410c'],
      aurora: ['rgb(255 149 0 / 0.46)', 'rgb(255 204 0 / 0.42)', 'rgb(255 92 60 / 0.34)'],
      rim: 'rgb(255 248 235 / 0.9)',
      glow: 'rgb(200 130 10 / 0.3)',
    },
    dark: {
      solid: '#ffc45c',
      gradient: ['#ff9f0a', '#ff6b35'],
      aurora: ['rgb(255 159 10 / 0.5)', 'rgb(255 214 10 / 0.34)', 'rgb(255 69 58 / 0.34)'],
      rim: 'rgb(255 240 214 / 0.5)',
      glow: 'rgb(255 159 10 / 0.3)',
    },
  },
  fuji: {
    light: {
      solid: '#0b6b4a',
      gradient: ['#0b6b4a', '#0e7490'],
      aurora: ['rgb(16 185 129 / 0.46)', 'rgb(45 212 191 / 0.42)', 'rgb(56 189 248 / 0.32)'],
      rim: 'rgb(240 255 250 / 0.88)',
      glow: 'rgb(16 150 110 / 0.28)',
    },
    dark: {
      solid: '#5fe3a8',
      gradient: ['#30d158', '#22d3ee'],
      aurora: ['rgb(48 209 88 / 0.46)', 'rgb(34 211 238 / 0.4)', 'rgb(129 199 132 / 0.28)'],
      rim: 'rgb(232 255 244 / 0.48)',
      glow: 'rgb(48 209 88 / 0.28)',
    },
  },
  agfa: {
    light: {
      solid: '#b03a19',
      gradient: ['#af441d', '#be123c'],
      aurora: ['rgb(239 68 68 / 0.42)', 'rgb(249 115 22 / 0.46)', 'rgb(244 63 94 / 0.36)'],
      rim: 'rgb(255 244 238 / 0.88)',
      glow: 'rgb(190 60 30 / 0.3)',
    },
    dark: {
      solid: '#ffb08a',
      gradient: ['#ff7a45', '#ff375f'],
      aurora: ['rgb(255 122 69 / 0.5)', 'rgb(255 55 95 / 0.42)', 'rgb(255 171 64 / 0.3)'],
      rim: 'rgb(255 238 228 / 0.5)',
      glow: 'rgb(255 122 69 / 0.3)',
    },
  },
  ilford: {
    light: {
      solid: '#345c8f',
      gradient: ['#345c8f', '#4c1d95'],
      aurora: ['rgb(59 130 246 / 0.44)', 'rgb(99 102 241 / 0.44)', 'rgb(56 189 248 / 0.32)'],
      rim: 'rgb(240 246 255 / 0.88)',
      glow: 'rgb(52 92 143 / 0.3)',
    },
    dark: {
      solid: '#a8c8ff',
      gradient: ['#6e9bd8', '#9b95ff'],
      aurora: ['rgb(110 155 216 / 0.5)', 'rgb(155 149 255 / 0.42)', 'rgb(56 189 248 / 0.28)'],
      rim: 'rgb(236 244 255 / 0.48)',
      glow: 'rgb(110 155 216 / 0.3)',
    },
  },
  polaroid: {
    light: {
      solid: '#5145c4',
      gradient: ['#5c4aca', '#a21caf'],
      aurora: ['rgb(91 91 214 / 0.46)', 'rgb(168 85 247 / 0.44)', 'rgb(236 72 153 / 0.32)'],
      rim: 'rgb(246 243 255 / 0.88)',
      glow: 'rgb(92 74 202 / 0.3)',
    },
    dark: {
      solid: '#c9b8ff',
      gradient: ['#bf5af2', '#ff6482'],
      aurora: ['rgb(191 90 242 / 0.5)', 'rgb(122 107 255 / 0.44)', 'rgb(255 100 130 / 0.28)'],
      rim: 'rgb(248 240 255 / 0.5)',
      glow: 'rgb(191 90 242 / 0.3)',
    },
  },
  sakura: {
    light: {
      solid: '#b03060',
      gradient: ['#af3564', '#db2777'],
      aurora: ['rgb(236 72 153 / 0.42)', 'rgb(244 114 182 / 0.44)', 'rgb(255 138 76 / 0.3)'],
      rim: 'rgb(255 245 249 / 0.9)',
      glow: 'rgb(200 60 110 / 0.3)',
    },
    dark: {
      solid: '#ffb0cc',
      gradient: ['#ff375f', '#ff9ed2'],
      aurora: ['rgb(255 55 95 / 0.46)', 'rgb(255 158 210 / 0.42)', 'rgb(255 138 76 / 0.26)'],
      rim: 'rgb(255 240 246 / 0.5)',
      glow: 'rgb(255 55 95 / 0.3)',
    },
  },
}

export function glassAccentTheme(id: AccentId, theme: 'light' | 'dark'): GlassAccentTheme {
  return (GLASS_ACCENTS[id] ?? GLASS_ACCENTS[DEFAULT_ACCENT])[theme]
}

export function glassAccentGradient(id: AccentId, theme: 'light' | 'dark') {
  const [from, to] = glassAccentTheme(id, theme).gradient
  return `linear-gradient(135deg, ${from}, ${to})`
}

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === 'string' && ACCENTS.some((accent) => accent.id === value)
}
