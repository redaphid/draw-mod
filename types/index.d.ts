export type ListenerStatus = 'waiting' | 'listening' | 'failing'

export type Listener = {
  key: string
  lane?: string
  owner?: string
  board?: string
  frame?: string
  lastSent?: string
  // The display names the agent took with draw's `open` or `name`, which other agents' chat lines may name it by.
  names?: string[]
  status: ListenerStatus
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    draw: { listeners: Listener[]; scopes: Record<string, string>; forgotten: Record<string, string> }
  }
}
