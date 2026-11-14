export type Deadline = number

declare module 'claude-code' {
  interface PluginState {
    embercache: { until: Deadline }
  }
}
