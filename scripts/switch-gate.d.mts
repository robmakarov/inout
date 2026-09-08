/** Types for the switch-count gate (scripts/switch-gate.mjs). */
export interface SwitchCount {
  count: number
  ceiling: number
  ids: string[]
}
export declare function countIn(source: string): SwitchCount | null
/**
 * `messages` is every commit message in the push. A ceiling raise is refused
 * unless one of them carries Robert's ruling for these exact numbers — see
 * `ruledRaise` and the gate's own header.
 */
export declare function verdict(
  next: SwitchCount | null,
  prev: SwitchCount | null,
  messages?: string,
): string[]
export declare function ruledRaise(messages: string, from: number, to: number): boolean
