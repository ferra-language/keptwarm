export type Deadline = number

declare module 'claude-code' {
  interface PluginState {
    keepwarm: { until: Deadline }
  }
}
