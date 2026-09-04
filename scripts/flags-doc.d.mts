/** Types for the FLAGS.md index generator (scripts/flags-doc.mjs). */
export declare const BEGIN: string
export declare const END: string
export interface DocSpec {
  id: string
  storageKey: string | null
  kind: string
  options: string[] | null
  fallback: string | null
  group: string
  label: string
  hint: string
}
export declare function specs(source: string): DocSpec[]
export declare function index(rows: DocSpec[]): string
export declare function rewrite(doc: string, block: string): string
