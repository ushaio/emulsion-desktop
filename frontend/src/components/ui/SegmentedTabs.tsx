'use client'

import { useId, type ComponentType, type KeyboardEvent, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { usePreferences } from '@/store/preferences'
import { GlassBackdrop } from './liquid-glass'

/**
 * 分段式多页签控件（系统设置「主题」同款视觉）：
 * - 容器为圆角描边条，选中项以 accent 填充；
 * - semantic="tabs" 渲染 tablist/tab 语义（roving tabindex）；
 *   semantic="radio" 渲染 radiogroup/radio 语义（设置项互斥选择）；
 * - size="md" 用于设置表单行，size="sm" 用于工具栏 / 面板头等紧凑场景；
 * - itemAttributes / onItemKeyDown 供宿主透传自动化定位属性与键盘导航。
 */

export interface SegmentedTabOption<T extends string = string> {
  value: T
  label: string
  icon?: ComponentType<{ size?: number; className?: string }>
  /** 标签右侧附加节点；传入函数时以选中态作为参数（如随选中变色的徽标） */
  trailing?: ReactNode | ((active: boolean) => ReactNode)
  title?: string
  /**
   * 该项当前不可选。用于「该分组下没有任何可用内容」这类情形：置灰比允许点击
   * 却毫无反应更诚实，且配合 title 能说明原因。键盘导航会跳过它。
   */
  disabled?: boolean
}

interface SegmentedTabsProps<T extends string = string> {
  value: T
  options: SegmentedTabOption<T>[]
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  semantic?: 'tabs' | 'radio'
  /** 按钮是否平分容器宽度（默认 true；工具栏内联场景传 false） */
  fill?: boolean
  ariaLabel?: string
  className?: string
  itemAttributes?: (value: T) => Record<string, string>
  onItemKeyDown?: (event: KeyboardEvent<HTMLButtonElement>, value: T) => void
}

export function SegmentedTabs<T extends string = string>({
  value,
  options,
  onChange,
  size = 'md',
  semantic = 'tabs',
  fill = true,
  ariaLabel,
  className,
  itemAttributes,
  onItemKeyDown,
}: SegmentedTabsProps<T>) {
  const isLarge = size === 'md'
  const glass = usePreferences(state => state.appearance === 'liquid-glass')
  const reducedMotion = useReducedMotion()
  const lensId = useId()
  return (
    <div
      role={semantic === 'radio' ? 'radiogroup' : 'tablist'}
      aria-label={ariaLabel}
      className={cn(
        'desktop-segmented-tabs flex items-center rounded-md border bg-background p-0.5',
        isLarge ? 'h-10' : 'h-8',
        className,
      )}
    >
      {glass && <GlassBackdrop />}
      {options.map(({ value: optionValue, label, icon: Icon, trailing, title, disabled }) => {
        const active = optionValue === value
        return (
          <button
            key={optionValue}
            type="button"
            disabled={disabled}
            role={semantic === 'radio' ? 'radio' : 'tab'}
            {...(semantic === 'radio'
              ? { 'aria-checked': active }
              : { 'aria-selected': active, tabIndex: active ? 0 : -1 })}
            onClick={() => onChange(optionValue)}
            onKeyDown={(event) => {
              onItemKeyDown?.(event, optionValue)
              if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
              const index = options.findIndex(option => option.value === optionValue)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % options.length
                  : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index - 1 + options.length) % options.length : -1
              if (next < 0) return
              // 落在禁用项上就停住，不绕回去：跳到别的分组会让方向键的行为难以预测。
              if (options[next]?.disabled) return
              event.preventDefault()
              onChange(options[next].value)
              const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(':scope > button')
              buttons?.[next]?.focus()
            }}
            title={title}
            {...itemAttributes?.(optionValue)}
            className={cn(
              'flex min-w-0 items-center justify-center rounded font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
              isLarge ? 'h-8 gap-2 px-3 text-xs' : 'h-7 gap-1.5 px-2.5 text-[11px]',
              fill && 'min-w-0 flex-1',
            )}
            style={{
              backgroundColor: active ? 'var(--accent)' : 'transparent',
              color: active ? 'var(--accent-foreground)' : 'var(--muted-foreground)',
            }}
          >
            {glass && active && <motion.span
              aria-hidden="true"
              className="lg-lens"
              layoutId={lensId}
              initial={false}
              transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
            />}
            {Icon ? <Icon size={isLarge ? 14 : 12} className="shrink-0" /> : null}
            <span className="truncate">{label}</span>
            {typeof trailing === 'function' ? trailing(active) : trailing}
          </button>
        )
      })}
    </div>
  )
}
