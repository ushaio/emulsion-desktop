import React from 'react'
import { createRoot } from 'react-dom/client'
import { Palette } from 'lucide-react'
import { ThemeAppearance } from '@/contexts/ThemeContext'
import { AppearanceTab } from '@/pages/settings/AppearanceTab'
import { GlassSurface } from '@/components/ui/liquid-glass'
import { usePreferences } from '@/store/preferences'
import './index.css'

// A separate development entry renders real settings without the native bridge.
usePreferences.persist.setOptions({ name: 'mo-gallery-theme-preview' })
if (localStorage.getItem('mo-gallery-theme-preview')) {
  void usePreferences.persist.rehydrate()
} else {
  usePreferences.setState({ appearance: 'liquid-glass', theme: 'light', accent: 'silver' })
}

function ThemePreview() {
  return (
    <div className="theme-preview-page integrated-window-frame">
      <ThemeAppearance />
      <GlassSurface className="theme-preview-panel" material="regular" cornerRadius={14} padding="30px 34px">
        <header className="theme-preview-heading"><Palette size={23} /><h1>Emulsion</h1></header>
        <AppearanceTab />
      </GlassSurface>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ThemePreview /></React.StrictMode>)
