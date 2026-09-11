import type { HTMLAttributes, ReactNode } from 'react'
import { GlassBackdrop } from '@/components/ui/liquid-glass'

interface LibraryToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

/**
 * 资源库通用内容工具栏容器（玻璃条 + 下边框）。
 * spread `...rest` 以保留 `data-local-library-guide` 等属性。
 */
export function LibraryToolbar({
  children,
  className,
  style,
  ...rest
}: LibraryToolbarProps) {
  return (
    <div
      {...rest}
      className={`desktop-material-toolbar lg-sheet relative flex min-h-13 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 ${className ?? ''}`}
      style={{ borderColor: 'var(--border)', ...style }}
    >
      <GlassBackdrop />
      {children}
    </div>
  )
}
