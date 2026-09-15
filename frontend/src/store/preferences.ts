import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { DEFAULT_ACCENT, type AccentId } from '@/lib/accents'
import {
  GLASS_DEFAULTS,
  normalizeTuning,
  type GlassCanvas,
  type RefractionMode,
  type GlassTuning,
} from '@/lib/liquid-glass'
import { DEFAULT_ZINE_VIEW_OPTIONS, type ZineViewOptionKey, type ZineViewOptions } from '@/lib/zine/view-options'
import type { ZineAiMode } from '@/lib/zine/zine-ai-permission'

type PhotoViewMode = 'crop' | 'fit' | 'masonry'

interface AdminPreferences extends GlassTuning {
  photoColumns: number
  photoGridSize: number
  photoViewMode: PhotoViewMode
  language: 'zh' | 'en'
  theme: 'light' | 'dark' | 'system'
  appearance: 'classic' | 'liquid-glass'
  /** What the glass refracts: the accent-coloured light field, or a flat neutral ground. */
  glassCanvas: GlassCanvas
  reduceTransparency: boolean
  accent: AccentId
  sidebarCollapsed: boolean
  /**
   * 经典外观下把侧栏画成半透明磨砂面（背板柔光从底下透出），并把侧栏的次级文字
   * 加深一档 —— 半透明面板的对比度不够，得从文字这边补回来。是一组联动的视觉处理。
   * 液态玻璃外观有自己的光幕与材质，这个开关对它没有作用。
   */
  sidebarFrosted: boolean
  zineStripWidth: number
  zineViewOptions: ZineViewOptions
  zineAiMode: ZineAiMode
  zineFavoriteFonts: string[]
  setPhotoColumns: (n: number) => void
  setPhotoGridSize: (n: number) => void
  setPhotoViewMode: (mode: PhotoViewMode) => void
  setLanguage: (lang: 'zh' | 'en') => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setAppearance: (appearance: 'classic' | 'liquid-glass') => void
  setGlassCanvas: (canvas: GlassCanvas) => void
  setReduceTransparency: (enabled: boolean) => void
  /** Partial patch: the appearance panel edits one knob at a time. */
  setGlassTuning: (patch: Partial<GlassTuning>) => void
  setGlassMode: (mode: RefractionMode) => void
  resetGlassTuning: () => void
  setAccent: (accent: AccentId) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setSidebarFrosted: (enabled: boolean) => void
  setZineStripWidth: (n: number) => void
  setZineViewOption: (key: ZineViewOptionKey, enabled: boolean) => void
  setZineAiMode: (mode: ZineAiMode) => void
  toggleZineFavoriteFont: (fontFamily: string) => void
}

export const usePreferences = create<AdminPreferences>()(
  persist(
    (set) => ({
      photoColumns: 6,
      photoGridSize: 176,
      photoViewMode: 'fit',
      language: 'zh',
      theme: 'system',
      appearance: 'classic',
      ...GLASS_DEFAULTS,
      glassCanvas: 'aurora',
      reduceTransparency: false,
      accent: DEFAULT_ACCENT,
      sidebarCollapsed: false,
      sidebarFrosted: true,
      zineStripWidth: 176,
      zineViewOptions: DEFAULT_ZINE_VIEW_OPTIONS,
      zineAiMode: 'ask',
      zineFavoriteFonts: [],
      setPhotoColumns: (n) => set({ photoColumns: n }),
      setPhotoGridSize: (n) => set({ photoGridSize: n }),
      setPhotoViewMode: (mode) => set({ photoViewMode: mode }),
      setLanguage: (lang) => set({ language: lang }),
      setTheme: (theme) => set({ theme }),
      setAppearance: (appearance) => set({ appearance }),
      setGlassCanvas: (glassCanvas) => set({ glassCanvas }),
      setReduceTransparency: (reduceTransparency) => set({ reduceTransparency }),
      setGlassTuning: (patch) => set(patch),
      setGlassMode: (mode) => set({ mode }),
      resetGlassTuning: () => set({ ...GLASS_DEFAULTS }),
      setAccent: (accent) => set({ accent }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSidebarFrosted: (sidebarFrosted) => set({ sidebarFrosted }),
      setZineStripWidth: (n) => set({ zineStripWidth: n }),
      setZineViewOption: (key, enabled) => set((state) => ({
        zineViewOptions: { ...state.zineViewOptions, [key]: enabled },
      })),
      setZineAiMode: (mode) => set({ zineAiMode: mode }),
      toggleZineFavoriteFont: (fontFamily) => set((state) => ({
        zineFavoriteFonts: state.zineFavoriteFonts.includes(fontFamily)
          ? state.zineFavoriteFonts.filter((font) => font !== fontFamily)
          : [...state.zineFavoriteFonts, fontFamily],
      })),
    }),
    {
      name: 'mo-gallery-preferences',
      // The glass material was rebuilt on liquid-glass-react, so the old
      // glassBackground / glassNeon keys no longer describe anything. Anything
      // that cannot be carried across is dropped rather than reinterpreted, and
      // the tuning is normalised because a persisted out-of-range value reaches
      // the SVG filter, where it renders as a blank sheet.
      version: 2,
      migrate: (persisted, version) => {
        const saved = (persisted ?? {}) as Record<string, unknown>
        if (version < 2) {
          // 'frosted' meant the accent-coloured field, which is now 'aurora'.
          saved.glassCanvas = saved.glassBackground === 'neutral' ? 'neutral' : 'aurora'
          delete saved.glassBackground
          delete saved.glassNeon
        }
        return saved as unknown as AdminPreferences
      },
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AdminPreferences>
        return {
          ...current,
          ...saved,
          ...normalizeTuning(saved),
          glassCanvas: saved.glassCanvas === 'neutral' ? 'neutral' : 'aurora',
          // 早于这个开关的存档里没有这个键 —— 缺省即开启（它描述的是经典外观侧栏
          // 本来的样子）。显式存过 false 的用户仍然拿到关。
          sidebarFrosted: saved.sidebarFrosted !== false,
        }
      },
    },
  ),
)

// 照片筛选（会话级，不持久化）
interface PhotoFilters {
  search: string
  category: string
  photoType: string | null
  fileFormats: string[]
  channel: string | null
  albumId: string | null
  cameraId: string | null
  lensId: string | null
  featured: boolean | null
  sortBy: 'createdAt' | 'takenAt'
  sortOrder: 'asc' | 'desc'
  setSearch: (s: string) => void
  setCategory: (c: string) => void
  setPhotoType: (t: string | null) => void
  setFileFormats: (formats: string[]) => void
  setChannel: (c: string | null) => void
  setAlbumId: (id: string | null) => void
  setCameraId: (id: string | null) => void
  setLensId: (id: string | null) => void
  setFeatured: (f: boolean | null) => void
  setSortBy: (s: 'createdAt' | 'takenAt') => void
  setSortOrder: (o: 'asc' | 'desc') => void
  reset: () => void
}

const defaultFilters = {
  search: '',
  category: '全部',
  photoType: null as string | null,
  fileFormats: [] as string[],
  channel: null as string | null,
  albumId: null as string | null,
  cameraId: null as string | null,
  lensId: null as string | null,
  featured: null as boolean | null,
  sortBy: 'createdAt' as const,
  sortOrder: 'desc' as const,
}

export const usePhotoFilters = create<PhotoFilters>()((set) => ({
  ...defaultFilters,
  setSearch: (s) => set({ search: s }),
  setCategory: (c) => set({ category: c }),
  setPhotoType: (t) => set({ photoType: t }),
  setFileFormats: (formats) => set({ fileFormats: formats }),
  setChannel: (c) => set({ channel: c }),
  setAlbumId: (id) => set({ albumId: id }),
  setCameraId: (id) => set({ cameraId: id }),
  setLensId: (id) => set({ lensId: id }),
  setFeatured: (f) => set({ featured: f }),
  setSortBy: (s) => set({ sortBy: s }),
  setSortOrder: (o) => set({ sortOrder: o }),
  reset: () => set(defaultFilters),
}))

// 资源库左侧分区折叠状态（持久化：用户操作的展开/折叠跨页面保留，首次进入默认展开）
export type LibrarySectionKey =
  | 'cloudPhotoType'
  | 'cloudCategories'
  | 'cloudAlbums'
  | 'localFolders'
  | 'localCollections'
  | 'localTags'
  | 'localColors'
  | 'localRatings'

interface LibrarySectionsState {
  sections: Record<LibrarySectionKey, boolean>
  toggleSection: (key: LibrarySectionKey) => void
}

const defaultSections: Record<LibrarySectionKey, boolean> = {
  cloudPhotoType: true,
  cloudCategories: true,
  cloudAlbums: true,
  localFolders: true,
  localCollections: true,
  localTags: true,
  localColors: true,
  localRatings: true,
}

export const useLibrarySections = create<LibrarySectionsState>()(
  persist(
    (set) => ({
      sections: defaultSections,
      toggleSection: (key) => set((state) => ({ sections: { ...state.sections, [key]: !state.sections[key] } })),
    }),
    { name: 'mo-gallery-library-sections' },
  ),
)

// 系统设置左侧导航（持久化：重新打开设置时回到上次停留的分区）
export type SettingsTabKey =
  | 'site'
  | 'storage'
  | 'plugins'
  | 'comments'
  | 'account'
  | 'local-library'
  | 'cache'
  | 'ai'
  | 'agent-extensions'
  | 'appearance'
  | 'log'
  | 'about'

interface SettingsNavState {
  tab: SettingsTabKey
  setTab: (tab: SettingsTabKey) => void
}

export const useSettingsNav = create<SettingsNavState>()(
  persist(
    (set) => ({
      tab: 'site',
      setTab: (tab) => set({ tab }),
    }),
    { name: 'mo-gallery-settings-nav' },
  ),
)

// 上传页参数（持久化：下次进入上传页时复用上次的设置；标题属于单次内容，不持久化）
export interface UploadPageSettings {
  uploadType: 'digital' | 'film'
  categories: string[]
  albumIds: string[]
  storyId: string
  filmRollId: string
  storageSourceId: string
  storagePath: string
  compressEnabled: boolean
  compressionFormat: 'webp' | 'avif'
  maxSizeMB: number
  showFlag: boolean
  stripGPS: boolean
  useCustomPrefix: boolean
}

interface UploadSettingsState extends UploadPageSettings {
  setUploadSettings: (patch: Partial<UploadPageSettings>) => void
}

export const defaultUploadPageSettings: UploadPageSettings = {
  uploadType: 'digital',
  categories: [],
  albumIds: [],
  storyId: '',
  filmRollId: '',
  storageSourceId: '',
  storagePath: '',
  compressEnabled: true,
  compressionFormat: 'avif',
  maxSizeMB: 4,
  showFlag: true,
  stripGPS: false,
  useCustomPrefix: false,
}

export const useUploadSettings = create<UploadSettingsState>()(
  persist(
    (set) => ({
      ...defaultUploadPageSettings,
      setUploadSettings: (patch) => set(patch),
    }),
    { name: 'mo-gallery-upload-settings' },
  ),
)
