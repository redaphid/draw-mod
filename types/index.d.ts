export type ListenerStatus = 'waiting' | 'listening' | 'failing'

export type Listener = {
  key: string
  lane?: string
  owner?: string
  board?: string
  frame?: string
  lastSent?: string
  status: ListenerStatus
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    draw: { listeners: Listener[]; scopes: Record<string, string>; forgotten: Record<string, string> }
  }
}
