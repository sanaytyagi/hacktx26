/// <reference types="vite/client" />
import type { RelayBridge } from '../../preload/index'

declare global {
  interface Window {
    relay: RelayBridge
  }
}
export {}
