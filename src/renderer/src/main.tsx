import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import './styles/globals.css'
import { queryClient, startEventBridge } from './lib/api'
import { TooltipProvider } from './components/ui/misc'
import { App } from './App'

document.documentElement.classList.toggle('dark', localStorage.getItem('relay-theme') === 'dark')
startEventBridge()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
        <Toaster position="bottom-right" richColors closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>
)
