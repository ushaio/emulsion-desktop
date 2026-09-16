/**
 * AdminContext 适配器 — 对齐 web 端 useAdmin() 接口。
 * desktop 不需要完整的管理页面布局，只提供 StoriesTab/BlogTab 所需的 context。
 */
'use client'

import React, { createContext, useContext, useCallback, useState, useEffect } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { GetTags, GetSettings } from '../../../wailsjs/go/main/App'

interface AdminContextType {
  handleUnauthorized: () => void
  settings: Record<string, string> | null
  tags: string[]
}

const AdminContext = createContext<AdminContextType | null>(null)

export function useAdmin() {
  const context = useContext(AdminContext)
  if (!context) {
    return {
      handleUnauthorized: () => {},
      settings: null as Record<string, string> | null,
      tags: [] as string[],
    }
  }
  return context
}

export function AdminLogsProvider({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [settings, setSettings] = useState<Record<string, string> | null>(null)
  const [tags, setTags] = useState<string[]>([])

  const handleUnauthorized = useCallback(() => {
    logout()
    navigate('/library?source=local', { replace: true })
  }, [logout, navigate])

  useEffect(() => {
    ;(async () => {
      try {
        const s = await GetSettings()
        setSettings(s || {})
      } catch {}
      try {
        const c = await GetTags()
        setTags(c || [])
      } catch {}
    })()
  }, [])

  return (
    <AdminContext.Provider value={{ handleUnauthorized, settings, tags }}>
      {children}
    </AdminContext.Provider>
  )
}
