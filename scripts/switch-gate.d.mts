/** Types for the switch-count gate (scripts/switch-gate.mjs). */
export interface SwitchCount {
  count: number
  ceiling: number
  ids: string[]
}
export declare function countIn(source: string): SwitchCount | null
export declare function verdict(next: SwitchCount | null, prev: SwitchCount | null): string[]
