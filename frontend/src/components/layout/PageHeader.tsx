import type { ReactNode } from 'react'
import { GlassBackdrop } from '@/components/ui/liquid-glass'

interface PageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="desktop-page-header lg-sheet flex h-14 shrink-0 items-center justify-between border-b px-6"
      style={{ borderColor: 'var(--border)' }}>
      <GlassBackdrop />
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {description && (
          <p style={{ color: 'var(--muted-foreground)' }}>
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
