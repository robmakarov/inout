/**
 * What an exported file is called — ONE builder, because there were four.
 *
 * `inout-29-08-2026-134512.mp4` — day, month, year, then the clock time, in the
 * take's own local timezone.
 *
 * IT IS DAY-FIRST ON PURPOSE (Robert 2026-08-29: "why date is reversed? dd mm
 * yyyy"). The old `inout-20260829-134512` was ISO-ordered, which sorts
 * lexicographically in a file manager and is unreadable to the person who has
 * to find their own recording in a Downloads folder. Sorting is what the file
 * manager's Date column is for; the name is for reading. Separators between
 * every date field so 08 and 29 cannot be mistaken for each other, and the
 * clock stays compact so the name does not become a paragraph.
 *
 * render.ts, instant.ts, smartCut.ts and ai/build.ts each had their own copy of
 * this, so the three export paths could have disagreed about the name of the
 * same take and nothing would have noticed.
 */

/** `29-08-2026-134512` — the shared stem, without extension or suffix. */
export function exportStem(createdAt: number): string {
  const d = new Date(createdAt)
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${date}-${time}`
}

/** `inout-29-08-2026-134512.mp4`. `ext` includes its leading dot. */
export function exportFileName(createdAt: number, ext: string): string {
  return `inout-${exportStem(createdAt)}${ext}`
}
