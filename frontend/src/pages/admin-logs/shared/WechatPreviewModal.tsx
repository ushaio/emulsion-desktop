'use client'

/**
 * 微信公众号效果预览弹窗。
 *
 * 规格取证（唯一来源）：
 *   ① res.wx.qq.com/mmbizappmsg/zh_CN/htmledition/js/assets/
 *      tencent_portfolio_light.mtwuki0w9fb3572c.css（light 主题）
 *   ② 参考文章 mp.weixin.qq.com/s/4Op0SJZIUVRu-IIA_cae4Q 在 390×844（iPhone UA）
 *      与 1280×900 两种视口下的 getComputedStyle 实测
 * 实测结论：手机版与 .pages_skin_pc 桌面版的排版数值完全一致，唯一差异是
 * .rich_media_area_primary_inner 的 max-width（桌面 677px），故本预览统一按手机版
 * （390px 宽）取值。类名与取值逐条列在 index.css 的 `.wechat-*` 区块里。
 *
 * 对旧实现的修正（均为实测推翻了原推断）：
 *   - 「原创」徽章不是 .icon_appmsg_tag.default（15px / 1px 描边 / .67em 圆角胶囊），
 *     参考页用的是基础变体 .icon_appmsg_tag.appmsg_title_tag：12px / line-height 1.67 /
 *     padding 0 4px / 圆角 2px / 底色 rgba(0,0,0,.05) / 无描边 / margin-right 8px。
 *   - 页面内边距是 20px 20px 0（--appmsgPageGap=20px、--richMediaAreaPrimaryPaddingTop=20px），
 *     不是 16px 侧边距 + 64px 顶距；正文宽度 = 视口 - 40px。
 *   - 发布时间是「YYYY年M月D日 HH:MM」（实测 2026年8月10日 12:03），当年同样带年份，
 *     且带时分——原实现按“当年省略年份”且不带时间。
 *   - meta 行是 font-size:0 + inline-block 条目（margin:0 10px 10px 0），不是 flex+gap。
 *   - 正文段落节奏由 .autoTypeSetting24psection>p{…margin-bottom:24px} 给出，不是 0.9em。
 *   - 引用块没有左边框也没有底色，左侧竖条是 ::before 画的 1.5px 圆角条。
 *   - 底栏是 60px 固定高（1px 边线 + 8 + 43 + 8），账号条是 32px 圆形头像 + 15px/500 昵称，
 *     互动按钮 4 × 39px、图标 24×24、标签 12px/18px；正文后的独立「公众号名片」在参考页
 *     并不存在（.rich_media_area_extra 实测高度 0，账号信息位于底栏 #js_like_profile_bar）。
 *
 * 已登记的主动偏差（D1-D6）：
 *   D1 正文标题层级：平台 CSS 对 .rich_media_content 内的 h1-h6 没有任何规则，参考页正文
 *      h1-h6 实测数量为 0（微信编辑器不产出语义标题）。700 字重 + 17px 以实测 <strong> 为锚，
 *      22/20/18 三级字号属推断值——待补一份含小标题的公众号文章实测后回收。
 *   D2 段落间距：平台规则只作用于 .autoTypeSetting24psection 的直接子元素（参考页正文块自带
 *      内联样式，嵌套 p 实测 margin 为 0）。本应用正文由 Milkdown 生成、无内联样式，故把 24px
 *      施加到全部块级元素，否则嵌套块之间将完全没有间距。
 *   D3 图片宽度：参考页图片由内联 width/aspect-ratio 定宽（318px，外层 section 带 16px 内缩，
 *      该内缩在 326 个 section 中出现 44 次，属作者样式而非平台默认），我们按微信编辑器默认的
 *      整栏宽度呈现。
 *   D4 底栏上边线：微信原值 border-top:.5px，改为 1px 以避免非整数像素在不同 DPR 下的舍入差异。
 *   D5 互动图标：微信使用私有 masked 图标字体，此处改用 lucide 线性图标，尺寸对齐实测的 24×24 框。
 *   D6 导航条（标题 + 复制按钮）是应用自有 chrome——微信页面本身没有这层，标题栏在客户端原生层；
 *      卡片宽度取 390px（实测视口）而非原 420px。
 *
 * 主题：卡片根挂 data-wechat-theme，镜像微信自身的 data-weui-theme 机制；配色取值全部在
 * index.css 的 `[data-wechat-theme='dark']` 区块，组件不重复持有色值。
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Copy, MessageCircle, Share2, Star, ThumbsUp, X } from 'lucide-react'
import { getMilkdownText } from '@mo-gallery/milkdown/media'
import type { EditorType, PhotoDto } from '@/lib/api/types'
import { AdminButton } from '@/components/admin/AdminButton'
import { StoryRichContent } from '@/components/StoryRichContent'
import { GlassBackdrop } from '@/components/ui/liquid-glass'
import { useSettings } from '@/contexts/SettingsContext'
import { useTheme } from '@/contexts/ThemeContext'

/** 公众号名称固定值（本应用以 MO Gallery 名义发布） */
const WECHAT_ACCOUNT_NAME = 'MO Gallery'

/** 预览视口宽度：取证参考页的实测视口（iPhone 逻辑宽度 390px） */
const WECHAT_VIEWPORT_WIDTH = 390

interface WechatPreviewModalProps {
  title: string
  editorType: EditorType
  tiptapContent: string
  milkContent?: string | null
  photos?: PhotoDto[]
  /** 文章作者名（meta 行灰色文字项；默认取站点标题 site_title） */
  authorName?: string
  /** 发布时间（毫秒时间戳）；按微信规则渲染为「YYYY年M月D日 HH:MM」 */
  publishedAt?: number
  /** 发布时间标签；直接显示（优先于 publishedAt） */
  dateLabel?: string
  cdnDomain?: string
  /** 复制结果提示（toast）；未传时仅显示按钮内的瞬时状态 */
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void
  t: (key: string) => string
  onClose: () => void
}

/** 微信发布时间格式：始终「YYYY年M月D日 HH:MM」（对齐参考页实测，当年不省略年份） */
function wechatDateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

export function WechatPreviewModal({
  title,
  editorType,
  tiptapContent,
  milkContent,
  photos,
  authorName,
  publishedAt,
  dateLabel,
  cdnDomain,
  notify,
  t,
  onClose,
}: WechatPreviewModalProps) {
  const { settings } = useSettings()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle')

  // 复制为公众号文本：标题 + 正文纯文本（对齐编辑器 copyToWechat 的实现）
  const copyAsWechatText = async () => {
    try {
      const bodyText = editorType === 'milkdown'
        ? getMilkdownText(milkContent ?? '')
        : tiptapContent.replace(/<[^>]+>/g, '')
      const text = title ? `${title}\n\n${bodyText}` : bodyText
      await navigator.clipboard?.writeText(text)
      setCopyState('success')
      notify?.(t('editor.copy_success'), 'success')
    } catch (error) {
      console.error('Failed to copy for WeChat:', error)
      setCopyState('error')
      notify?.(t('editor.copy_failed'), 'error')
    } finally {
      window.setTimeout(() => setCopyState('idle'), 2000)
    }
  }

  // 底栏互动项顺序与文案对齐参考页：赞 / 分享 / 推荐 / 写留言
  const oprItems = [
    { key: 'like', label: t('admin.preview_wechat_like'), icon: <ThumbsUp strokeWidth={1.6} /> },
    { key: 'share', label: t('admin.preview_wechat_share'), icon: <Share2 strokeWidth={1.6} /> },
    { key: 'recommend', label: t('admin.preview_wechat_wow'), icon: <Star strokeWidth={1.6} /> },
    { key: 'comment', label: t('admin.preview_wechat_comment'), icon: <MessageCircle strokeWidth={1.6} /> },
  ]

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-zinc-950/70 p-4 backdrop-blur-sm md:p-10"
      onClick={onClose}
    >
      <AdminButton
        onClick={onClose}
        adminVariant="icon"
        className="fixed right-6 top-6 z-[110] bg-background/80 p-3 backdrop-blur-sm"
      >
        <X className="w-5 h-5" />
      </AdminButton>

      {/* 公众号文章页卡片：宽度取参考页实测视口 390px；配色由 data-wechat-theme 驱动 */}
      <div
        data-wechat-theme={isDark ? 'dark' : 'light'}
        onClick={(event) => event.stopPropagation()}
        className="lg-sheet flex h-full max-h-[92vh] w-full flex-col overflow-hidden shadow-2xl"
        style={{
          borderRadius: 0,
          maxWidth: WECHAT_VIEWPORT_WIDTH,
          backgroundColor: isDark ? '#191919' : '#ffffff',
        }}
      >
        <GlassBackdrop material="regular" />

        {/* 应用自有导航条（非微信页面元素）：居中标题 + 复制为公众号文本 */}
        <div
          className="flex h-11 shrink-0 items-center justify-between px-4"
          style={{ borderBottom: `1px solid ${isDark ? 'rgba(255, 255, 255, 0.1)' : '#f4f4f5'}` }}
        >
          <span className="w-6" aria-hidden="true" />
          <span
            className="min-w-0 flex-1 truncate px-2 text-center text-[13px]"
            style={{ color: isDark ? 'rgba(255, 255, 255, 0.8)' : '#18181b' }}
          >
            {title || t('story.untitled')}
          </span>
          <button
            type="button"
            onClick={() => void copyAsWechatText()}
            title={t('editor.copy_wechat')}
            aria-label={t('editor.copy_wechat')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors"
            style={{ color: isDark ? 'rgba(255, 255, 255, 0.4)' : '#a1a1aa' }}
          >
            {copyState === 'success'
              ? <Check className="h-4 w-4 text-[#07c160]" />
              : <Copy className="h-4 w-4" />}
          </button>
        </div>

        <div className="custom-scrollbar flex-1 overflow-y-auto">
          {/* .rich_media_area_primary：内边距 20px 20px 0 */}
          <div className="wechat-page">
            {/* .rich_media_title */}
            <h1 className="wechat-title">{title || t('story.untitled')}</h1>

            {/* .rich_media_meta_list → 原创徽章 / 作者 / 账号昵称 / 发布时间 */}
            <div className="wechat-meta-list">
              <span className="wechat-tag">原创</span>
              <span className="wechat-meta wechat-meta--text">{authorName || settings.site_title}</span>
              <span className="wechat-meta wechat-meta--link">{WECHAT_ACCOUNT_NAME}</span>
              <span className="wechat-meta wechat-meta--text">
                {dateLabel || (publishedAt ? wechatDateLabel(publishedAt) : t('admin.preview_wechat_today'))}
              </span>
            </div>

            {/* .rich_media_content：#js_content 的排版规则见 index.css .wechat-article-content */}
            <div className="wechat-article-content">
              <StoryRichContent
                editorType={editorType}
                tiptapContent={tiptapContent}
                milkContent={milkContent}
                photos={photos}
                cdnDomain={cdnDomain}
                className="story-rich-content--article"
              />
            </div>
          </div>

          {/* body{padding-bottom:95px} —— 给固定底栏留白 */}
          <div className="wechat-page-bottom-gap" aria-hidden="true" />
        </div>

        {/* .bottom_bar_wrp：底栏 60px = 1px 上边线 + 8 + 43 + 8 */}
        <div className="wechat-bottom-bar">
          <div className="wechat-bottom-bar__inner">
            {/* 账号条 #js_like_profile_bar */}
            <div className="wechat-follow">
              <img src="/logo.png" alt={WECHAT_ACCOUNT_NAME} className="wechat-follow__avatar" />
              <span className="wechat-follow__name">{WECHAT_ACCOUNT_NAME}</span>
            </div>

            {/* 互动组 .interaction_bar */}
            <div className="wechat-opr" aria-hidden="true">
              {oprItems.map(({ key, label, icon }) => (
                <div key={key} className="wechat-opr__item">
                  <span className="wechat-opr__btn">
                    {icon}
                    <span className="wechat-opr__label">{label}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
