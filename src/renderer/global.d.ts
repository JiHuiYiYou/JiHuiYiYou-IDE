import type { JhyyIdeApi } from '@shared/ipc'

declare global {
  interface Window {
    jhyyIde: JhyyIdeApi
  }
}

export {}
