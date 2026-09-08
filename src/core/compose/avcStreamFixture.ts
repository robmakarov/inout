/**
 * A REAL H.264 STREAM FROM THIS MACHINE'S HARDWARE ENCODER — test material for
 * J13, captured 2026-09-08 by `npm run exp -- skipframe` at 640x384 through the
 * export's own `constantQualityCodec` (which picked avc1.42E01e: Baseline,
 * CAVLC, pic_order_cnt_type 0 — the same shape it picks at 1080p, 1440p, native
 * and 4K, all four measured the same hour).
 *
 * WHY IT IS HERE AND NOT IN A TEST FILE: two suites read it (the bitstream and
 * the ordering machine) and a fixture copied into both is a fixture that will
 * disagree with itself. Nothing in the product imports this.
 *
 * FOUR PACKETS, in decode order: one IDR and three P pictures, POC 0,1,2,3 and
 * frame_num 0,1,2,3 — the numbering that leaves no room for an inserted
 * picture, which is exactly the case the engine has to renumber around.
 */
const AVCC_B64 = [
    'AUIAHv/hABMnQgAeiYoSBQGNNQEBAQeEAhEwAQAEKM48gA==',
].join('')

const PACKET_B64: readonly { readonly type: 'key' | 'delta'; readonly b64: string }[] = [
  { type: 'key', b64: [
    'AAAEXiW4AEAAjf//+HooAAgr+8VvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvrFa6666666666666666666666666666',
    '666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666',
    '66666666666666666666666666666666666666666666666666666666666666666666666666/j//BXxQABCUxBASEAAEAg',
    'AAQQ0IEyIEzwcAEAIZBwAQAhntbW1tbW18eH/gqgesICA4+wgTPBwAQAhnp66666666666666666666666666666665u9LS0',
    'tLS0tPT1111111111111111111111111111111111111109PXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXT09ddddddd',
    'dddddddddddddddddddddddddddddddPT1111111111111111111111111111111111111109PXXXXXXXXXXXXXXXXXXXXXX',
    'XXXXXXXXXXXXXXXXT09ddddddddddddddddddddddddddddddf/8fgt4oAAhK4hNCAACASAEWJJkSTODgBACmQcAIAUy1tbW',
    '1tbX8Pj+CqYQgJSmxJM8HACAFM09ddddddddddddddddddddddddddddddc3tS0tLS0tLS11111111111111111111111111',
    '111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111',
    '111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111',
    '111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111',
    '///wQ+ABYMRX2ltkAzhs2W7f/d9zhXgahJEdRf1EkP/+UOuAE9GBDmfGil3VmXgdTO2OJf3b1FLrrrrrrrrrrrrrrrrrrrrr',
    'rrrrrrrrrrrrrrrr/sx+HhTAVECpLBdWuJ53wAFGgC0lAq+tg4v/8HGxFKdj53twF6pF6r7OzpYrMaIwX0JwvOiMJB9Tw01/',
    'qwiQE3KPEIK4vgPzAfCoKbCRST/k8/V3924AQR+cUtEHQJZe3ctEcjRra/1hMMqYXJKeUfrYMPIjgqONJj3AVH2ZnBF7wv1b',
    '/gDtEaMAeBswlRnm2N/e/cv/WwEV3AQxQ/pAQwP+cHyF1R3QdWmMPP9qsbIIEjX76sEZ9MOkylPh/hPE7ps+88DAAX+S4ARs',
    'uwPnxgAAmW0hjnvXrw5LXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXg',
  ].join('') },
  { type: 'delta', b64: [
    'AAABCiHgAgASVnUb+B0gn/1UE/+qgn/1UE/+qgn/1UE/zf/w4c8BwADYAcBIBZM0eaECwMfG+luAK2mAxnJ80sBAJA4heBpw',
    '/8W81OddfD/zvOf18P/O85/Xw/87zn9fD/zvOf18P/O85/Xw/83w/4MFUsILu3HO4AopoBDvT5jiF18P/6qCf/VQT/6qCf/V',
    'QT/6qCf/VQT/6qCf/VQT/6qocDJvKG5ci/yiQq8FAaF8AILfSma7wK/56bTP/4wJHiP1KYOP/ydd7wSf6qjfKv/D+AB+w+vO',
    'FKgIh7aAqCiw5QXzx1BRAy/pjVwD/8JbgDGOzTxJBj5z3LFylgntKphpN0V/UbH/A2D+fgj+',
  ].join('') },
  { type: 'delta', b64: [
    'AAAB1iHgBAAlokpDuN4KP9VBP/qoJ/9VBP/qoJ/9VBP8/oDPYgNcDgAEo6Z17KANE0XH5ckASa4cQvA0z18Adpuxy55ACX3M',
    'Pf6rN4D/7Ic6689fDgJfcw4CX3MPf6rO85/Xnr4cBL7mHAS+5h7/VZ3nP689fDgJfcw4CX3MPf6rO85/Xnr4cBL7mHAS+5h7',
    '/VZ3nP689fDgJfcw4CX3MPf6rO85/Xnr4cBL7mHAS+5h7/VZvD/gDBVARCAAjtZxOvACdMIiuYBW+rxxC689fDgJfcwGi2/P',
    'y54e/A0CVUE/+qgn/1UE/+qgn/1UE/+qgn/1UE/+qgn/1VF5P/FBIcEDcAFJpbt3n/FRxPWLny5CfKZDhU3iYbKLwA2UVjqX',
    'f9QwBq22+28H8AFRUa7o6dRAACGk4cpXYqmjnSLoJP9VRZPZCoSExJvJxUDxIK6yH27v5nHMw+xk19GZsMR8QSYK6p3gwioz',
    'Nnbf/gEzqiqEfnUhjz+Wka0c19//50AAIAIEmIOCyB8ABAYjpXM+uyAZo2fNAakAY/wwhkTp7/sBGRtoTZVVG//+m23sMq4p',
    'd/6wsALHAKiYkMFi98mT+3+E855ZGYO8VoIaZKcZe+0qFmJGIznhwR/A',
  ].join('') },
  { type: 'delta', b64: [
    'AAABJyHgBgA1skpTkjeCj/VQT/6qCf/VQT/6qCf/VQT/6rP7A0+eBpw9/qs/necW94e/1WfzvOd4e/1WfzvOd4e/1WfzvOd4',
    'e/1WfzvOd4e/1WfzvOd4e/1Wf2Bp88DTh7/VQT/6qCf/VQT/6qCf/VQT/6qCf/VQT/6qCf/VUXv8TETeADu/OI8n95+Xf18X',
    'j1X/ASN0f/cgN+/VfJ/3Ak/1VFvxMojyYLaAGJURKG5P35WQhBHeoiwWgbQWgc5RKGgkmFCikGd4gLr+Y4LLrkk9lf/f4LMf',
    '+ABTYStYGSSleK//ULkZD/RLbzMgycMpbfWNKTK4sgWAu3gdGDvf+BokmnZDK+rz8DmoSqz6vn3BQFGpNwlNGIVmgFUP//lX',
    'ubqd+BOOb3V4I/g=',
  ].join('') },
]

function decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The avcC the encoder handed back with its first packet. */
export const FIXTURE_AVCC = decode(AVCC_B64)

/** The first four packets, length-prefixed exactly as WebCodecs emitted them. */
export const FIXTURE_PACKETS = PACKET_B64.map((p) => ({ type: p.type, data: decode(p.b64) }))
