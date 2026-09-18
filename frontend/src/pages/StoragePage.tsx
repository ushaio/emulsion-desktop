import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Eye,
  FileImage,
  FileWarning,
  Folder,
  FolderOpen,
  Github,
  HardDrive,
  ImageOff,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Trash2,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { SimpleDeleteDialog } from '@/components/admin/SimpleDeleteDialog'
import { SelectDropdown } from '@/components/ui/SelectDropdown'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { useCachedPageEffect } from '@/hooks/useCachedPageEffect'
import { getErrorMessage } from '@/lib/auth-errors'
import { t } from '@/lib/i18n'
import { usePreferences } from '@/store/preferences'
import { CleanupStorage, FixMissingPhotos, GenerateThumbnail, GetDesktopStorageSources, ScanStorage } from '../../wailsjs/go/main/App'
import type { services, storage_plugins } from '../../wailsjs/go/models'

// ── 工具函数 ─────────────────────────────────────────────────

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB']

function formatSize(bytes: number): string {
  if (bytes === 0) return '-'
  const k = 1024
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), SIZE_UNITS.length - 1)
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${SIZE_UNITS[i]}`
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']

function isImageFile(key: string): boolean {
  const lower = key.toLowerCase()
  return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))
}

function folderOf(key: string): string {
  const lastSlash = key.lastIndexOf('/')
  return lastSlash >= 0 ? key.substring(0, lastSlash) : '/'
}

// 三种「缺失」状态：记录存在、但存储里没有文件。按缺失范围区分——
// 原图与缩略图均缺失 / 仅缺失原图 / 仅缺失缩略图。这套口径与服务器端
// /admin/storage/scan 完全一致，因此两个后端的状态筛选行为相同。
const MISSING_STATUSES = new Set(['missing', 'missing_original', 'missing_thumbnail'])

// 缺失对象在源上已不存在，没有可展示的地址；只有源上真实存在的图片才能预览。
function canPreview(file: Pick<services.StorageObjectDTO, 'key' | 'url' | 'status'>): boolean {
  if (!isImageFile(file.key) || !file.url) return false
  return !MISSING_STATUSES.has(file.status)
}

// ── 持久化（与照片库/胶卷一致：localStorage + mo-gallery 前缀）──

const PROVIDER_KEY = 'mo-gallery:storage:provider'
const SECTIONS_KEY = 'mo-gallery:storage:sections'

function readLocal(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore quota / privacy mode errors
  }
}

interface StorageSections {
  overview: boolean
  folders: boolean
}

function readSections(): StorageSections {
  try {
    const raw = window.localStorage.getItem(SECTIONS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StorageSections>
      return { overview: parsed.overview !== false, folders: parsed.folders !== false }
    }
  } catch {
    // ignore malformed state
  }
  return { overview: true, folders: true }
}

function writeSections(sections: StorageSections) {
  try {
    window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections))
  } catch {
    // ignore quota / privacy mode errors
  }
}

// 文件夹树展开状态（null = 未初始化，首次进入默认展开第一层）
const EXPANDED_KEY = 'mo-gallery:storage:expanded-folders'

function readExpandedFolders(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    // ignore malformed state
  }
  return null
}

function writeExpandedFolders(paths: Set<string>) {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...paths]))
  } catch {
    // ignore quota / privacy mode errors
  }
}

// ── 文件夹树 ─────────────────────────────────────────────────

interface FolderTreeNode {
  name: string
  path: string
  count: number
  children: FolderTreeNode[]
}

/** 由「目录路径 → 文件数」构建文件夹树；节点 count 为整棵子树的聚合文件数 */
function buildFolderTree(counts: Map<string, number>): FolderTreeNode[] {
  const roots: FolderTreeNode[] = []
  const index = new Map<string, FolderTreeNode>()

  for (const path of [...counts.keys()].sort()) {
    if (path === '/') {
      let root = index.get('/')
      if (!root) {
        root = { name: '/', path: '/', count: 0, children: [] }
        index.set('/', root)
        roots.push(root)
      }
      root.count = counts.get('/') ?? 0
      continue
    }

    const segments = path.split('/')
    let current = ''
    let siblings = roots
    for (let i = 0; i < segments.length; i++) {
      current = i === 0 ? segments[0] : `${current}/${segments[i]}`
      let node = index.get(current)
      if (!node) {
        node = { name: segments[i], path: current, count: 0, children: [] }
        index.set(current, node)
        siblings.push(node)
      }
      if (i === segments.length - 1) node.count = counts.get(path) ?? 0
      siblings = node.children
    }
  }

  const sortRecursive = (nodes: FolderTreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const node of nodes) sortRecursive(node.children)
  }
  sortRecursive(roots)

  const aggregate = (node: FolderTreeNode): number => {
    let total = node.count
    for (const child of node.children) total += aggregate(child)
    node.count = total
    return total
  }
  for (const root of roots) aggregate(root)

  return roots
}

function countTreeNodes(nodes: FolderTreeNode[]): number {
  let total = nodes.length
  for (const node of nodes) total += countTreeNodes(node.children)
  return total
}

/** 首次进入的默认展开集合：展开第一层（顶层文件夹） */
function defaultExpandedFolders(nodes: FolderTreeNode[]): Set<string> {
  return new Set(nodes.map(node => node.path))
}

// ── 元数据 ───────────────────────────────────────────────────

/**
 * Which backend serves a source — the page administers two worlds and routes
 * every operation by this value.
 *
 * 'web'    — the source lives on the server (local / s3 / github). Objects and
 *            photo records both belong to the server, so every call is a proxy
 *            round-trip and needs a connection.
 * 'plugin' — a Desktop storage plugin source. Reconciled locally against the
 *            local library, and works offline.
 */
type ProviderKind = 'web' | 'plugin'

interface ProviderOption {
  value: string
  label?: string
  labelKey?: string
  icon: LucideIcon
  kind: ProviderKind
  /** Concrete storage product; only Desktop plugin sources carry one. */
  vendor?: string
  vendorLabel?: string
}

// Human-readable names for the vendor ids shared with the web server. Unknown
// ids fall through to the raw value so a newly added provider still renders
// something meaningful instead of an empty label.
const VENDOR_LABELS: Record<string, string> = {
  'cloudflare-r2': 'Cloudflare R2',
  'qiniu-kodo': '七牛云 Kodo',
  'aliyun-oss': '阿里云 OSS',
  'tencent-cos': '腾讯云 COS',
  'aws-s3': 'AWS S3',
  minio: 'MinIO',
  github: 'GitHub',
  webdav: 'WebDAV',
  local: '本地',
}

function vendorLabel(vendor?: string): string {
  if (!vendor) return ''
  return VENDOR_LABELS[vendor] ?? vendor
}

// Server-side storage sources. A fixed enum configured on the server rather
// than fetched, matching the web admin's own provider list. They come FIRST so
// the tab order stays "server, then this machine".
const WEB_PROVIDERS: ProviderOption[] = [
  { value: 'local', labelKey: 'admin.storage_provider_local', icon: HardDrive, kind: 'web' },
  { value: 's3', label: 'S3', icon: Cloud, kind: 'web' },
  { value: 'github', labelKey: 'admin.storage_provider_github', icon: Github, kind: 'web' },
]

// Desktop storage sources come from the installed storage plugins, so they are
// derived from SourceDTO rather than the legacy web enum. Only enabled sources
// can be scanned: a disabled plugin has no runtime to list objects with.
//
// The icon keys off vendor first: several providers share the s3-compatible
// plugin, and "which product is this?" is the more useful distinction than
// "which adapter speaks to it?".
function sourceIcon(pluginId: string, vendor?: string): LucideIcon {
  const key = (vendor || pluginId).toLowerCase()
  if (key.includes('github')) return Github
  if (key.includes('webdav') || key.includes('minio') || key.includes('local') || key === 'local' || key.includes('fs')) return HardDrive
  return Cloud
}

// getProviders builds the source tabs: server sources first, plugin sources
// after.
//
// Only `enabled` is filtered for plugins: the backend's
// GetDesktopStorageSources already excludes sources whose plugin is not
// installed, because those cannot list objects and would render a tab that can
// only ever error. Filtering again on `pluginInstalled` would hide a backend
// regression instead of surfacing it, so this trusts the binding's contract
// deliberately.
function getProviders(sources: storage_plugins.SourceDTO[]): ProviderOption[] {
  const pluginSources: ProviderOption[] = sources
    .filter(source => source.enabled)
    .map(source => ({
      value: source.id,
      label: source.name || source.pluginId || source.id,
      icon: sourceIcon(source.pluginId ?? '', source.vendor),
      kind: 'plugin' as const,
      vendor: source.vendor,
      vendorLabel: vendorLabel(source.vendor),
    }))
  return [...WEB_PROVIDERS, ...pluginSources]
}

interface StatusMeta {
  labelKey: string
  pillClass: string
  iconClass: string
}

const STATUS_META: Record<string, StatusMeta> = {
  linked: {
    labelKey: 'admin.storage_linked',
    pillClass: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    iconClass: 'text-emerald-500',
  },
  orphan: {
    labelKey: 'admin.storage_orphan',
    pillClass: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    iconClass: 'text-amber-500',
  },
  missing: {
    labelKey: 'admin.storage_missing',
    pillClass: 'bg-red-500/10 text-red-600 dark:text-red-400',
    iconClass: 'text-red-500',
  },
  missing_original: {
    labelKey: 'admin.storage_missing_original',
    pillClass: 'bg-red-500/10 text-red-600 dark:text-red-400',
    iconClass: 'text-red-500',
  },
  missing_thumbnail: {
    labelKey: 'admin.storage_missing_thumb',
    pillClass: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    iconClass: 'text-orange-500',
  },
}

function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] || { labelKey: '', pillClass: 'bg-muted text-muted-foreground', iconClass: 'text-muted-foreground' }
}

// ── 小组件 ───────────────────────────────────────────────────

function SectionHeader({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-9 w-full shrink-0 items-center justify-between gap-2 border-b px-3 transition-colors hover:bg-secondary/60"
      style={{ borderColor: 'var(--border)' }}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {open ? (
          <ChevronDown size={12} className="shrink-0" style={{ color: 'var(--muted-foreground)' }} />
        ) : (
          <ChevronRight size={12} className="shrink-0" style={{ color: 'var(--muted-foreground)' }} />
        )}
        <span className="text-[10px] font-medium uppercase tracking-[0.16em]" style={{ color: 'var(--muted-foreground)' }}>{label}</span>
      </span>
      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums" style={{ color: 'var(--muted-foreground)' }}>{count}</span>
    </button>
  )
}

function StatusPill({ status, language }: { status: string; language: 'zh' | 'en' }) {
  const meta = statusMeta(status)
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.pillClass}`}>
      <span className="size-1 rounded-full bg-current" />
      {meta.labelKey ? t(meta.labelKey, language) : status}
    </span>
  )
}

function FileThumb({ file }: { file: services.StorageObjectDTO }) {
  const [failed, setFailed] = useState(false)
  // 缺失对象在源上已不存在，不能再去取图：占位图标直接表达状态。
  const isMissing = file.status === 'missing_original' || file.status === 'missing_thumbnail'
  const showImage = isImageFile(file.key) && Boolean(file.url) && !failed && !isMissing

  let placeholder = <FileImage size={15} style={{ color: 'var(--muted-foreground)' }} />
  if (file.status === 'missing_original') placeholder = <FileWarning size={15} className="text-red-400" />
  else if (file.status === 'missing_thumbnail') placeholder = <ImageOff size={15} className="text-orange-400" />

  return (
    <span
      className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md border"
      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--muted)' }}
    >
      {showImage ? (
        <img src={file.url} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />
      ) : placeholder}
    </span>
  )
}

// ── 主组件 ───────────────────────────────────────────────────

function StorageCleanupPage() {
  const { language } = usePreferences()
  const [storageSources, setStorageSources] = useState<storage_plugins.SourceDTO[]>([])
  const [provider, setProvider] = useState(() => readLocal(PROVIDER_KEY, ''))
  const [files, setFiles] = useState<services.StorageObjectDTO[]>([])
  const [scanVendor, setScanVendor] = useState('')
  const [scanSourceName, setScanSourceName] = useState('')
  const [stats, setStats] = useState<services.StorageScanStats>({
    total: 0, linked: 0, orphan: 0, missing: 0, missingOriginal: 0, missingThumbnail: 0,
  })
  const [loading, setLoading] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false)
  const [cleanupDeleting, setCleanupDeleting] = useState(false)
  const [generatingThumb, setGeneratingThumb] = useState<Set<string>>(new Set())
  const [sections, setSections] = useState<StorageSections>(readSections)
  const [expandedFolders, setExpandedFolders] = useState<Set<string> | null>(readExpandedFolders)
  // 正在浏览哪个分组的源列表（null = 收起）。注意它**不等于**当前生效的分组：
  // 点 DESKTOP 只是打开它的列表，选中的源变了才算切过去。
  const [menuKind, setMenuKind] = useState<ProviderKind | null>(null)
  const groupStackRef = useRef<HTMLDivElement | null>(null)

  // 点击面板外 / Esc 收起。收起不改变当前存储源——没选就等于没切。
  useEffect(() => {
    if (menuKind === null) return
    const handleMouseDown = (event: MouseEvent) => {
      if (groupStackRef.current && !groupStackRef.current.contains(event.target as Node)) {
        setMenuKind(null)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuKind(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuKind])

  const toggleSection = (key: keyof StorageSections) => {
    setSections(prev => {
      const next = { ...prev, [key]: !prev[key] }
      writeSections(next)
      return next
    })
  }

  // ── 数据加载 ─────────────────────────────────────────────

  const providers = useMemo(() => getProviders(storageSources), [storageSources])

  // 当前选中源属于哪个后端。表格同时展示两个存储世界，所有操作都要按它路由。
  // 未选中任何源时回落到首个源所在的分组（校正 effect 随后会把它选中），
  // 这样分组 tab 的高亮与下拉内容从一开始就一致。
  const activeProvider = useMemo(
    () => providers.find(p => p.value === provider),
    [providers, provider],
  )
  const activeKind: ProviderKind = activeProvider?.kind ?? providers[0]?.kind ?? 'web'

  // 源名的显示文案：服务器源走 i18n（要跟随语言切换），插件源用自身名字。
  const providerLabelOf = useCallback(
    (item: ProviderOption) => (item.labelKey ? t(item.labelKey, language) : (item.label || item.value)),
    [language],
  )

  // 展开面板里的候选源：按**正在浏览的分组**过滤（可能与当前生效分组不同，
  // 因为点击 tab 尚未提交），不与另一组混合。
  const providerOptions = useMemo(
    () => providers
      .filter(item => item.kind === menuKind)
      .map(item => ({ value: item.value, label: providerLabelOf(item) })),
    [providers, menuKind, providerLabelOf],
  )

  const activeSourceLabel = activeProvider ? providerLabelOf(activeProvider) : ''
  // 标题前缀：标明当前源属于哪个分组。tab 标签只写分组名，源名要靠这里限定。
  const activeKindLabel = t(
    activeKind === 'web' ? 'admin.storage_group_web' : 'admin.storage_group_desktop',
    language,
  )

  // 分组 tab：始终只有 WEB / DESKTOP 两项，标签只表明分组，不掺入源名
  // （当前源由 tab 右侧的标题单独显示）。
  const groupOptions = useMemo(
    () => ([
      { value: 'web' as ProviderKind, label: t('admin.storage_group_web', language), icon: Server },
      { value: 'plugin' as ProviderKind, label: t('admin.storage_group_desktop', language), icon: HardDrive },
    ]).map(option => ({
      ...option,
      // 没有可用源的分组置灰：该组多半是插件全未安装（卸载会保留源记录，
      // 但不可用的源不会出现在这里），可点却无反应会让人以为界面坏了。
      disabled: !providers.some(item => item.kind === option.value),
    })),
    [providers, language],
  )

  const loadFiles = useCallback(async () => {
    if (!provider) {
      setFiles([])
      setScanVendor('')
      setScanSourceName('')
      setStats({ total: 0, linked: 0, orphan: 0, missing: 0, missingOriginal: 0, missingThumbnail: 0 })
      setSelected(new Set())
      return
    }
    setLoading(true)
    try {
      // 状态筛选在客户端完成（见 baseList），此处只按源取完整清单。
      // kind 决定这次扫描走服务器代理还是本地插件运行时。
      const result = await ScanStorage({ provider, kind: activeKind })
      setFiles(result?.files || [])
      setScanVendor(result?.vendor || '')
      setScanSourceName(result?.sourceName || '')
      setStats(result?.stats || { total: 0, linked: 0, orphan: 0, missing: 0, missingOriginal: 0, missingThumbnail: 0 })
      // 裁剪已不在结果中的选中项
      setSelected(prev => {
        const keys = new Set((result?.files || []).map(f => f.key))
        return new Set([...prev].filter(key => keys.has(key)))
      })
    } catch (err: unknown) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [provider, activeKind])

  const fetchSources = useCallback(async () => {
    try {
      const result = await GetDesktopStorageSources()
      setStorageSources(result || [])
    } catch {}
  }, [])

  // 同步存储源列表后校正 provider：仅在当前源失效时切到第一个可用源。
  // 首次进入时 provider 为空，这里会选中列表首项（服务器「本地存储」），随后触发扫描。
  useEffect(() => {
    if (providers.length === 0) return
    if (providers.some(p => p.value === provider)) return
    const timer = window.setTimeout(() => {
      const next = providers[0].value
      setProvider(next)
      writeLocal(PROVIDER_KEY, next)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [providers, provider])

  // 首次进入自动扫描；菜单页常驻缓存后，切回本页不再重复扫描，
  // 需要最新结果时使用工具栏的「扫描 / 刷新」按钮（切换存储源仍会自动重扫）
  //
  // 存储源列表与文件清单分开加载：清单依赖 provider，而 provider 由下面那个
  // 校正 effect 在拿到插件源列表后写入。两者合在一个 effect 里会在首次进入时
  // 用空 provider 抢先跑一次扫描，白跑一趟且让校正 effect 的 setProvider 白费。
  useCachedPageEffect(() => {
    void fetchSources()
  }, [fetchSources])

  useCachedPageEffect(() => {
    void loadFiles()
  }, [loadFiles])

  // 搜索防抖（400ms 自动触发本地过滤）
  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchInput.trim()), 400)
    return () => window.clearTimeout(handle)
  }, [searchInput])

  const switchProvider = (next: string) => {
    if (next === provider) return
    setProvider(next)
    writeLocal(PROVIDER_KEY, next)
    setFolderFilter(null)
    setSelected(new Set())
    setSearchInput('')
    setSearch('')
  }

  // 点击分组 tab 只是**打开该组的源列表**，不切换分组——必须在下拉里选到源才真正切过去。
  // 点同一个 tab 是收起/再展开。`activeKind` 始终来自已选中的源，所以「没选」＝「没变」。
  const openGroupMenu = (kind: ProviderKind) => {
    if (!providers.some(item => item.kind === kind)) return
    setMenuKind(current => (current === kind ? null : kind))
  }

  const selectSource = (next: string) => {
    switchProvider(next)
    setMenuKind(null)
  }

  const clearSearch = () => {
    setSearchInput('')
    setSearch('')
  }

  // ── 客户端过滤：状态 + 搜索 + 仅异常 + 文件夹 ───────────
  //
  // 这些筛选全部在客户端完成：后端一次返回该源的完整清单。状态是严格相等匹配
  // （与服务器端 /admin/storage/scan 的 status 语义一致）——"missing" 专指
  // 「原图与缩略图均缺失」，另外两种缺失各有独立状态，不再折叠进来。

  const matchesStatus = useCallback((file: services.StorageObjectDTO) => {
    if (!statusFilter) return true
    return file.status === statusFilter
  }, [statusFilter])

  const baseList = useMemo(() => {
    let list = files
    if (search) {
      const needle = search.toLowerCase()
      list = list.filter(file =>
        file.key.toLowerCase().includes(needle) ||
        (file.photoTitle || '').toLowerCase().includes(needle),
      )
    }
    if (statusFilter) list = list.filter(matchesStatus)
    return issuesOnly ? list.filter(f => f.status !== 'linked') : list
  }, [files, issuesOnly, statusFilter, search, matchesStatus])

  const visibleFiles = useMemo(() => {
    if (!folderFilter) return baseList
    // 根目录：只匹配直接位于根的文件；其他目录：匹配整棵子树
    if (folderFilter === '/') return baseList.filter(file => folderOf(file.key) === '/')
    return baseList.filter(file => file.key.startsWith(`${folderFilter}/`))
  }, [baseList, folderFilter])

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const file of baseList) {
      const folder = folderOf(file.key)
      counts.set(folder, (counts.get(folder) || 0) + 1)
    }
    return counts
  }, [baseList])

  const folderTree = useMemo(() => buildFolderTree(folderCounts), [folderCounts])
  const folderTreeNodeCount = useMemo(() => countTreeNodes(folderTree), [folderTree])

  // 展开状态：null 表示未初始化（渲染时按「默认展开第一层」展示），用户操作后持久化
  const expandedSet = useMemo(
    () => expandedFolders ?? defaultExpandedFolders(folderTree),
    [expandedFolders, folderTree],
  )

  const toggleFolderExpanded = (path: string) => {
    setExpandedFolders(prev => {
      const base = prev ?? defaultExpandedFolders(folderTree)
      const next = new Set(base)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      writeExpandedFolders(next)
      return next
    })
  }

  const renderFolderTree = (nodes: FolderTreeNode[], depth = 0): ReactNode => (
    nodes.map(node => {
      const active = folderFilter === node.path
      const hasChildren = node.children.length > 0
      const collapsed = !expandedSet.has(node.path)
      return (
        <div key={node.path} style={{ paddingLeft: `${7 + Math.min(5, depth) * 12}px` }}>
          <div
            className="mb-0.5 flex w-full items-center rounded-md pr-2 text-xs transition-colors hover:bg-secondary"
            style={{ backgroundColor: active ? 'var(--accent)' : undefined }}
          >
            {hasChildren ? (
              <button
                type="button"
                aria-label={node.name}
                onClick={() => toggleFolderExpanded(node.path)}
                className="mr-0.5 flex size-4 shrink-0 items-center justify-center rounded hover:bg-black/10"
              >
                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
            ) : (
              <span className="mr-0.5 size-4 shrink-0" />
            )}
            <button
              type="button"
              onClick={() => setFolderFilter(active ? null : node.path)}
              onDoubleClick={() => { if (hasChildren) toggleFolderExpanded(node.path) }}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
            >
              <Folder size={13} className="shrink-0" style={{ color: 'var(--muted-foreground)' }} />
              <span
                className="min-w-0 flex-1 truncate font-mono"
                style={{ color: active ? 'var(--accent-foreground)' : 'var(--foreground)' }}
                title={node.path}
              >
                {node.name}
              </span>
              <span
                className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums"
                style={{ color: active ? 'var(--accent-foreground)' : 'var(--muted-foreground)' }}
              >
                {node.count}
              </span>
            </button>
          </div>
          {!collapsed && renderFolderTree(node.children, depth + 1)}
        </div>
      )
    })
  )

  const actionable = useMemo(() => visibleFiles.filter(f => f.status !== 'linked'), [visibleFiles])
  const allActionableSelected = actionable.length > 0 && actionable.every(f => selected.has(f.key))

  const toggleSelect = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAllActionable = () => setSelected(new Set(actionable.map(f => f.key)))
  const clearSelection = () => setSelected(new Set())

  const resetFilters = () => {
    setStatusFilter('')
    setIssuesOnly(false)
    setFolderFilter(null)
    setSearchInput('')
    setSearch('')
  }

  // ── 清理 / 缩略图操作 ───────────────────────────────────

  const handleCleanup = async () => {
    if (selected.size === 0 || cleanupDeleting) return

    // 孤立文件：源上存在、但没有任何照片记录引用 → 真正从源上删除。
    const orphanKeys = files
      .filter(f => selected.has(f.key) && f.status === 'orphan')
      .map(f => f.key)

    // 缺失文件：记录存在、但源上对象已不在 → 这不是删除源文件，而是修复记录。
    // 两个后端的修复内容不同（服务器删自己的照片行，桌面端清本地失效投影），
    // 由 kind 路由，前端只负责把属于该后端的 photoId 传回去。
    const missingIds = files
      .filter(f => selected.has(f.key) && f.photoId && MISSING_STATUSES.has(f.status))
      .map(f => f.photoId!)

    setCleanupDeleting(true)
    try {
      if (orphanKeys.length > 0) {
        await CleanupStorage({ provider, kind: activeKind, keys: orphanKeys })
      }

      if (missingIds.length > 0) {
        await FixMissingPhotos({ kind: activeKind, photoIds: missingIds })
      }

      setSelected(new Set())
      setCleanupDialogOpen(false)
      loadFiles()
      toast.success(t('admin.storage_cleanup_success', language))
    } catch (err: unknown) {
      toast.error(getErrorMessage(err))
    } finally {
      setCleanupDeleting(false)
    }
  }

  const handleGenerateThumb = async (file: services.StorageObjectDTO) => {
    if (!file.photoId) return
    setGeneratingThumb(prev => new Set(prev).add(file.photoId!))
    try {
      await GenerateThumbnail({ kind: activeKind, photoId: file.photoId })
      toast.success(t('admin.notify_success', language))
      loadFiles()
    } catch (err: unknown) {
      toast.error(getErrorMessage(err))
    } finally {
      setGeneratingThumb(prev => {
        const next = new Set(prev)
        next.delete(file.photoId!)
        return next
      })
    }
  }

  // ── 渲染数据 ─────────────────────────────────────────────

  const statusOptions = [
    { value: '', label: t('admin.all_status', language) },
    ...Object.keys(STATUS_META).map(status => ({ value: status, label: t(STATUS_META[status].labelKey, language) })),
  ]

  const statItems = [
    { status: '', labelKey: 'admin.storage_total', icon: HardDrive, count: stats.total, iconClass: 'text-muted-foreground' },
    { status: 'linked', labelKey: 'admin.storage_linked', icon: Link2, count: stats.linked, iconClass: STATUS_META.linked.iconClass },
    { status: 'orphan', labelKey: 'admin.storage_orphan', icon: AlertTriangle, count: stats.orphan, iconClass: STATUS_META.orphan.iconClass },
    { status: 'missing', labelKey: 'admin.storage_missing', icon: XCircle, count: stats.missing, iconClass: STATUS_META.missing.iconClass },
    { status: 'missing_original', labelKey: 'admin.storage_missing_original', icon: FileWarning, count: stats.missingOriginal, iconClass: STATUS_META.missing_original.iconClass },
    { status: 'missing_thumbnail', labelKey: 'admin.storage_missing_thumb', icon: ImageOff, count: stats.missingThumbnail, iconClass: STATUS_META.missing_thumbnail.iconClass },
  ]

  return (
    <>
      {/* 页面表头：与资源库同构——「图标徽标 + 页面名」在左，其后是分组 tab 与当前存储源。
          筛选/操作控件不在这一行，它们归到右侧内容区顶部（见下方 main）。 */}
      <div className="flex min-h-13 shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground">
            <HardDrive size={14} />
          </span>
          <span className="truncate text-xs font-semibold">
            {t('admin.page_storage', language)}
          </span>
        </div>

        {/* 分组 tab：WEB（服务器存储）/ DESKTOP（本机插件源）互斥。
            点击某个 tab 才在其下方展开该组的源列表——不是常驻控件，
            也不把两组混进同一个列表。 */}
        <div ref={groupStackRef} className="relative shrink-0">
          <SegmentedTabs
            size="sm"
            fill={false}
            ariaLabel={t('admin.storage_group', language)}
            value={activeKind}
            onChange={openGroupMenu}
            options={groupOptions.map(({ value, label, icon, disabled }) => ({
              value,
              label,
              icon,
              disabled,
              title: disabled ? t('admin.storage_group_empty', language) : label,
            }))}
          />

          {menuKind !== null && (
            <div
              role="listbox"
              aria-label={t('admin.storage_provider', language)}
              className="desktop-menu-surface absolute left-0 top-full z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border shadow-lg"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--background)' }}
            >
              {providerOptions.map(option => {
                const active = option.value === provider
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => selectSource(option.value)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50"
                    style={{ color: active ? 'var(--primary)' : 'var(--foreground)' }}
                  >
                    {/* 面板与 tab 等宽（较窄），长源名截断并靠 title 补全，
                        换行会把单行选项撑成多行、列表高度跳动。 */}
                    <span className="min-w-0 truncate" title={option.label}>{option.label}</span>
                    {active && <CheckCircle2 size={12} className="shrink-0" />}
                  </button>
                )
              })}
              {providerOptions.length === 0 && (
                <div className="px-3 py-1.5 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  {t('admin.storage_no_sources', language)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 当前存储源标题：紧跟在分组 tab 右侧。tab 标签只写分组名，
            所以这里带 `WEB - `/`DESKTOP - ` 前缀标明它属于哪一组。 */}
        {activeSourceLabel && (
          <span
            className="shrink-0 truncate text-xs font-medium"
            style={{ color: 'var(--foreground)', maxWidth: '16rem' }}
            title={`${activeKindLabel} - ${activeSourceLabel}`}
          >
            {activeKindLabel} - {activeSourceLabel}
          </span>
        )}

        {/* 插件源的具体存储产品：「s3-compatible」这类协议族名看不出对象实际存在哪，
            vendor 是两端共享的产品标识。归属在源信息里，故留在表头。 */}
        {activeKind === 'plugin' && scanVendor && (
          <span
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium"
            style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
            title={scanSourceName ? `${scanSourceName} · ${scanVendor}` : scanVendor}
          >
            <Cloud size={12} />
            {vendorLabel(scanVendor)}
          </span>
        )}
      </div>

      {/* 主区域：左侧概览/文件夹 + 右侧文件列表（桌面 master-detail） */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r bg-card" style={{ borderColor: 'var(--border)' }}>
          {/* 状态概览 */}
          <div className="shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
            <SectionHeader
              label={t('admin.storage_section_overview', language)}
              count={files.length}
              open={sections.overview}
              onToggle={() => toggleSection('overview')}
            />
            {sections.overview && (
              <div className="p-2">
                {statItems.map(item => {
                  const active = statusFilter === item.status
                  return (
                    <button
                      key={item.status || 'total'}
                      type="button"
                      onClick={() => {
                        setFolderFilter(null)
                        setStatusFilter(item.status)
                      }}
                      className="mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                      style={{ backgroundColor: active ? 'var(--accent)' : undefined }}
                    >
                      <item.icon size={13} className={`shrink-0 ${item.iconClass}`} />
                      <span className="min-w-0 flex-1 truncate text-left" style={{ color: active ? 'var(--accent-foreground)' : 'var(--muted-foreground)' }}>
                        {t(item.labelKey, language)}
                      </span>
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums" style={{ color: active ? 'var(--accent-foreground)' : 'var(--foreground)' }}>
                        {item.count}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* 文件夹（树形） */}
          <div className="flex min-h-0 flex-1 flex-col">
            <SectionHeader
              label={t('admin.storage_section_folders', language)}
              count={folderTreeNodeCount}
              open={sections.folders}
              onToggle={() => toggleSection('folders')}
            />
            {sections.folders && (
              <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
                <button
                  type="button"
                  onClick={() => setFolderFilter(null)}
                  className="mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                  style={{ backgroundColor: folderFilter === null ? 'var(--accent)' : undefined }}
                >
                  <FolderOpen size={13} className="shrink-0" style={{ color: 'var(--muted-foreground)' }} />
                  <span className="min-w-0 flex-1 truncate text-left" style={{ color: folderFilter === null ? 'var(--accent-foreground)' : 'var(--foreground)' }}>
                    {t('admin.storage_all_folders', language)}
                  </span>
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums" style={{ color: folderFilter === null ? 'var(--accent-foreground)' : 'var(--muted-foreground)' }}>
                    {baseList.length}
                  </span>
                </button>

                {renderFolderTree(folderTree)}

                {folderTree.length === 0 && (
                  <div className="px-2 py-6 text-center text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('admin.storage_no_files', language)}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* 右侧文件列表 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 筛选与操作条：原先挤在页面表头右侧，现下移到内容区顶部。
              这些控件作用的对象就是下面的文件列表，贴着它比放在表头更顺。 */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
            <SelectDropdown
              value={statusFilter}
              options={statusOptions}
              onChange={value => setStatusFilter(String(value))}
              placeholder={t('admin.all_status', language)}
              clearLabel={t('admin.all_status', language)}
              ariaLabel={t('admin.storage_file_status', language)}
              className="w-32 shrink-0"
            />

            {/* 仅异常 */}
            <button
              type="button"
              onClick={() => setIssuesOnly(value => !value)}
              className="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors hover:bg-secondary"
              style={{
                borderColor: 'var(--border)',
                backgroundColor: issuesOnly ? 'var(--accent)' : 'var(--background)',
                color: issuesOnly ? 'var(--accent-foreground)' : 'var(--muted-foreground)',
              }}
            >
              <AlertTriangle size={12} />
              {t('admin.storage_only_issues', language)}
            </button>

            {/* 搜索 */}
            <div className="relative min-w-0 max-w-sm flex-1">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted-foreground)' }} />
              <input
                type="text"
                value={searchInput}
                onChange={event => setSearchInput(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && setSearch(searchInput.trim())}
                placeholder={t('common.search', language)}
                className="h-8 w-full rounded-md border bg-input pl-8 pr-8 text-xs outline-none focus:ring-1"
                style={{ borderColor: 'var(--border)' }}
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label={t('common.close', language)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-secondary"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <button
              onClick={() => void loadFiles()}
              disabled={loading || !provider}
              className="ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
              style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <HardDrive size={14} />}
              {loading ? t('admin.storage_scanning', language) : t('admin.storage_scan', language)}
            </button>
          </div>

          {/* 列表头 */}
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3" style={{ borderColor: 'var(--border)' }}>
            <div className="flex min-w-0 items-center gap-2">
              {folderFilter ? (
                <span
                  className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px]"
                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--secondary)' }}
                >
                  <Folder size={11} style={{ color: 'var(--muted-foreground)' }} />
                  <span className="max-w-56 truncate font-mono">{folderFilter}</span>
                  <button
                    type="button"
                    onClick={() => setFolderFilter(null)}
                    aria-label={t('common.close', language)}
                    className="rounded p-0.5 hover:bg-black/10"
                  >
                    <X size={10} />
                  </button>
                </span>
              ) : (
                <span className="text-[10px] font-medium uppercase tracking-[0.16em]" style={{ color: 'var(--muted-foreground)' }}>
                  {t('admin.storage_file_list', language)}
                </span>
              )}
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums" style={{ color: 'var(--muted-foreground)' }}>
                {visibleFiles.length}
              </span>
              {issuesOnly && (
                <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle size={10} />
                  {t('admin.storage_only_issues', language)}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowGuide(value => !value)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[10px] transition-colors hover:bg-secondary"
              style={{ color: showGuide ? 'var(--primary)' : 'var(--muted-foreground)' }}
            >
              <CircleHelp size={12} />
              {t('admin.storage_help_title', language)}
            </button>
          </div>

          {/* 状态说明 */}
          {showGuide && (
            <div
              className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-1.5 text-[10px]"
              style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
            >
              <span className="flex items-center gap-1">
                <CheckCircle2 size={11} className="shrink-0 text-emerald-500" />
                {t('admin.storage_help_linked', language)}
              </span>
              <span className="flex items-center gap-1">
                <AlertTriangle size={11} className="shrink-0 text-amber-500" />
                {t('admin.storage_help_orphan', language)}
              </span>
              <span className="flex items-center gap-1">
                <XCircle size={11} className="shrink-0 text-red-500" />
                {t('admin.storage_help_missing', language)}
              </span>
            </div>
          )}

          {/* 选中操作条 */}
          {selected.size > 0 && (
            <div
              className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2"
              style={{ borderColor: 'var(--border)', backgroundColor: 'color-mix(in srgb, var(--primary) 6%, transparent)' }}
            >
              <span className="text-xs font-semibold" style={{ color: 'var(--primary)' }}>
                {t('admin.selected', language)} {selected.size}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAllActionable}
                  className="flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] transition-colors hover:bg-secondary"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
                >
                  <CheckCircle2 size={12} />
                  {t('admin.storage_select_all', language)}
                </button>
                <button
                  type="button"
                  onClick={() => setCleanupDialogOpen(true)}
                  disabled={cleanupDeleting}
                  className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
                  style={{ backgroundColor: 'var(--destructive)', color: 'var(--destructive-foreground)' }}
                >
                  {cleanupDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  {t('admin.storage_cleanup_selected', language)}
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={cleanupDeleting}
                  className="flex h-7 items-center rounded-md border px-2.5 text-[11px] transition-colors hover:bg-secondary disabled:opacity-50"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
                >
                  {t('common.cancel', language)}
                </button>
              </div>
            </div>
          )}

          {/* 列头 */}
          {visibleFiles.length > 0 && !loading && (
            <div
              className="hidden shrink-0 items-center gap-3 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] lg:flex"
              style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
            >
              <span className="flex w-8 shrink-0">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={allActionableSelected}
                  onChange={event => (event.target.checked ? selectAllActionable() : clearSelection())}
                  disabled={actionable.length === 0}
                  aria-label={t('admin.storage_select_all', language)}
                />
              </span>
              <span className="w-12 shrink-0" />
              <span className="min-w-0 flex-1">{t('admin.storage_file_key', language)}</span>
              <span className="hidden w-44 shrink-0 xl:block">{t('admin.photo_title', language)}</span>
              <span className="w-16 shrink-0 text-right">{t('admin.storage_file_size', language)}</span>
              <span className="hidden w-24 shrink-0 text-right md:block">{t('admin.storage_last_modified', language)}</span>
              <span className="w-28 shrink-0 text-right">{t('admin.storage_file_status', language)}</span>
              <span className="w-14 shrink-0" />
            </div>
          )}

          {/* 文件行 */}
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
            {/* 不存在「没有任何存储源」的状态：服务器存储源是固定枚举，永远在列表中，
                因此这里直接从加载态/空态开始。 */}
            {loading ? (
              Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                  <div className="size-4 shrink-0 animate-pulse rounded" style={{ backgroundColor: 'var(--muted)' }} />
                  <div className="size-11 shrink-0 animate-pulse rounded-md" style={{ backgroundColor: 'var(--muted)' }} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-3 w-1/3 animate-pulse rounded" style={{ backgroundColor: 'var(--muted)' }} />
                    <div className="h-2 w-1/4 animate-pulse rounded" style={{ backgroundColor: 'var(--muted)' }} />
                  </div>
                </div>
              ))
            ) : files.length === 0 ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-6" style={{ color: 'var(--muted-foreground)' }}>
                <span className="flex size-14 items-center justify-center rounded-lg" style={{ backgroundColor: 'var(--muted)' }}>
                  <HardDrive size={24} />
                </span>
                <p className="text-sm">{t('admin.storage_no_files', language)}</p>
                <button
                  onClick={() => void loadFiles()}
                  className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs"
                  style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}
                >
                  <HardDrive size={14} />
                  {t('admin.storage_scan', language)}
                </button>
              </div>
            ) : visibleFiles.length === 0 ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-6" style={{ color: 'var(--muted-foreground)' }}>
                <span className="flex size-14 items-center justify-center rounded-lg" style={{ backgroundColor: 'var(--muted)' }}>
                  <Search size={24} />
                </span>
                <p className="text-sm">{t('admin.storage_no_match', language)}</p>
                <button onClick={resetFilters} className="text-xs underline-offset-2 hover:underline" style={{ color: 'var(--muted-foreground)' }}>
                  {t('common.reset', language)}
                </button>
              </div>
            ) : (
              visibleFiles.map(file => {
                const selectedRow = selected.has(file.key)
                const name = file.key.split('/').pop() || file.key
                return (
                  <div
                    key={file.key}
                    className="group flex items-center gap-3 border-b px-3 py-2 transition-colors hover:bg-muted/30"
                    style={{
                      borderColor: 'var(--border)',
                      backgroundColor: selectedRow ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : undefined,
                    }}
                  >
                    <span className="flex w-8 shrink-0">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        checked={selectedRow}
                        onChange={() => toggleSelect(file.key)}
                        disabled={file.status === 'linked'}
                        title={file.status === 'linked' ? t('admin.storage_help_linked', language) : undefined}
                      />
                    </span>                    <FileThumb file={file} />
                    <div className="min-w-0 flex-1">
                      <div
                        className={`truncate font-mono text-xs ${canPreview(file) ? 'cursor-pointer hover:text-primary hover:underline' : ''}`}
                        title={file.key}
                        onClick={() => {
                          if (canPreview(file)) setPreviewUrl(file.url)
                        }}
                      >
                        {name}
                      </div>
                      <div className="truncate text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                        {folderOf(file.key)}
                      </div>
                    </div>
                    <span className="hidden w-44 shrink-0 truncate text-xs xl:block" style={{ color: 'var(--muted-foreground)' }} title={file.photoTitle}>
                      {file.photoTitle || '-'}
                    </span>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums">{formatSize(file.size)}</span>
                    <span className="hidden w-24 shrink-0 text-right text-[11px] md:block" style={{ color: 'var(--muted-foreground)' }}>
                      {file.lastModified ? new Date(file.lastModified).toLocaleDateString() : '-'}
                    </span>
                    <span className="flex w-28 shrink-0 justify-end">
                      <StatusPill status={file.status} language={language} />
                    </span>
                    <span className="flex w-14 shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100">
                      {canPreview(file) && (
                        <button
                          type="button"
                          onClick={() => setPreviewUrl(file.url)}
                          title={t('admin.preview', language)}
                          className="rounded p-1 transition-colors hover:bg-secondary"
                          style={{ color: 'var(--muted-foreground)' }}
                        >
                          <Eye size={13} />
                        </button>
                      )}
                      {/* 原图在、缩略图丢失时允许重新生成缓存 */}
                      {(file.status === 'linked' || file.status === 'missing_thumbnail') && !file.hasThumb && file.photoId && (
                        <button
                          type="button"
                          onClick={() => void handleGenerateThumb(file)}
                          disabled={generatingThumb.has(file.photoId)}
                          title={t('admin.storage_generate', language)}
                          className="rounded p-1 transition-colors hover:bg-secondary"
                          style={{ color: generatingThumb.has(file.photoId) ? 'var(--muted-foreground)' : 'var(--primary)' }}
                        >
                          {generatingThumb.has(file.photoId) ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <RefreshCw size={13} />
                          )}
                        </button>
                      )}
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </main>
      </div>

      {/* 底部状态栏：与照片库一致 */}
      <div className="flex min-h-10 shrink-0 items-center gap-3 border-t px-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card)' }}>
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          <span>{stats.total} {t('admin.storage_file_unit', language)}</span>
          <span className="opacity-60">·</span>
          <span className="flex items-center gap-1 text-emerald-500">
            <Link2 size={11} />{stats.linked} {t('admin.storage_linked', language)}
          </span>
          <span className="opacity-60">·</span>
          <span className="flex items-center gap-1 text-amber-500">
            <AlertTriangle size={11} />{stats.orphan} {t('admin.storage_orphan', language)}
          </span>
          <span className="opacity-60">·</span>
          <span className="flex items-center gap-1 text-red-500">
            <XCircle size={11} />{stats.missing + stats.missingOriginal + stats.missingThumbnail} {t('admin.storage_missing', language)}
          </span>
          {folderFilter && (
            <>
              <span className="opacity-60">·</span>
              <span className="max-w-48 truncate font-mono">{folderFilter}</span>
            </>
          )}
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadFiles()}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-[10px] hover:bg-secondary disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          {t('common.refresh', language)}
        </button>
      </div>

      {/* 图片预览 */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
          onClick={() => setPreviewUrl(null)}
        >
          <img
            src={previewUrl}
            alt={t('admin.preview', language)}
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={event => event.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setPreviewUrl(null)}
            aria-label={t('admin.close_preview', language)}
            className="absolute right-6 top-6 flex h-10 w-10 items-center justify-center rounded-md border border-white/20 bg-black/40 text-white/80 transition-colors hover:border-white/50 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>
      )}

      <SimpleDeleteDialog
        isOpen={cleanupDialogOpen}
        title={t('admin.storage_cleanup_selected', language)}
        message={`${t('admin.storage_cleanup_confirm', language)} (${selected.size})`}
        onConfirm={handleCleanup}
        onCancel={() => setCleanupDialogOpen(false)}
        t={(key) => t(key, language)}
      />
    </>
  )
}

export function StoragePage() {
  return <StorageCleanupPage />
}
