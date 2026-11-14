export type Deadline = number

declare module 'claude-code' {
  interface PluginState {
    keptwarm: { until: Deadline; win: number }
  }
}
