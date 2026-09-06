/* ==========================================================================
   APP PROTO — THE PROPOSED DESIGN LAYER (Robert, 2026-09-06).

   Hand-authored, inlined into proto/app.html by scripts/proto-app.mjs, and run
   ON a frozen snapshot of the shipping markup. It never re-renders the app: it
   walks the real DOM the app produced and rewrites the parts under discussion,
   so everything it does not touch is still exactly what ships. The panel's
   "As it ships / Proposed" switch turns it off, which is the A/B.

   It runs again after every state switch, and must be idempotent: each step
   marks what it has done and leaves it alone the second time.
   ========================================================================== */
;(function () {
  const ic = (n, cls) => `<svg class="${cls || ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`
  /* FIVE GLYPHS THE NEON SPRITE DOES NOT HAVE. Search, filter, sort, device and
     cloud are new controls, so there was nothing to borrow — the first pass
     pressed the eye, the gauge and a chevron into service and they read as
     nothing at all. Drawn to neon's own spec instead: 24-box, 1.8 stroke, round
     caps, no fill, so they sit in a row with the borrowed ones without a seam. */
  const DRAWN = {
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    sort: '<path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/>',
    device: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/>',
    cloud: '<path d="M7 18h10.5a3.5 3.5 0 0 0 .3-7 5.5 5.5 0 0 0-10.6-1.3A4.2 4.2 0 0 0 7 18z"/>',
  }
  const dic = (n) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DRAWN[n]}</svg>`
  /* the app names its inputs; neon draws them. One map, used by the chips and
     by the little kind badges on a card, so the two can never drift apart. */
  const GLYPH = { screen: 'display', camera: 'camera', mic: 'mic', 'tab audio': 'waves', 'system audio': 'waves', sound: 'waves' }
  const glyphFor = (label) => GLYPH[String(label || '').trim().toLowerCase()] || 'display'

  const bytes = (n) =>
    n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB'

  /* ---------- 1. the input chips: neon's glyph, the app's colour ---------- */
  function chips(root) {
    for (const b of root.querySelectorAll('.chip')) {
      if (b.dataset.dz) continue
      b.dataset.dz = '1'
      const label = b.getAttribute('title') || b.querySelector('span')?.textContent || ''
      const svg = b.querySelector('svg')
      if (svg) svg.outerHTML = ic(glyphFor(label))
    }
  }

  /* ---------- 2. the take cards ------------------------------------------ */
  function cards(root) {
    for (const card of root.querySelectorAll('.takecard')) {
      if (card.dataset.dz) continue
      card.dataset.dz = '1'

      // the length rides the picture, bottom right
      const len = card.querySelector('.takecard__len')
      const thumb = card.querySelector('.takecard__thumb')
      if (len && thumb && !thumb.querySelector('.dur')) {
        const d = document.createElement('span')
        d.className = 'dur'
        d.textContent = len.textContent.trim()
        thumb.appendChild(d)
      }

      // the full date and time, stamped onto the frozen card from the take's
      // own record at capture time — the app's own label is only a clock
      const when = card.querySelector('.takecard__when')
      if (when && when.dataset.whenFull) when.textContent = when.dataset.whenFull

      /* The inputs it used, as the chips in miniature — and on the SAME line as
         the date and the size, which is the order he named them in. */
      const kinds = card.querySelector('.takecard__kinds')
      const top = card.querySelector('.takecard__top')
      if (kinds && !kinds.querySelector('.kind')) {
        const names = kinds.textContent.split('·').map((s) => s.trim()).filter(Boolean)
        kinds.innerHTML = names.map((n) => `<span class="kind">${ic(glyphFor(n))}${n}</span>`).join('')
        const del = top?.querySelector('.takecard__del')
        if (del) top.insertBefore(kinds, del)
        else top?.appendChild(kinds)
      }

      // Watch and Edit go; the picture itself already opens the take
      for (const b of card.querySelectorAll('.takecard__actions .takecard__btn')) {
        const t = (b.textContent || '').trim().toLowerCase()
        if (t === 'watch' || t === 'edit') b.remove()
      }

      // the checkbox lane, empty until select mode is on
      if (!card.querySelector('.takecard__pick')) {
        const pick = document.createElement('div')
        pick.className = 'takecard__pick'
        pick.innerHTML = `<span class="pick">${ic('check')}</span>`
        card.insertBefore(pick, card.firstChild)
      }
    }
  }

  /* ---------- 3. the bar above the list ---------------------------------- */
  const SORTS = [
    { id: 'new', label: 'Newest first' },
    { id: 'old', label: 'Oldest first' },
    { id: 'big', label: 'Largest first' },
  ]

  function head(root) {
    const takes = root.querySelector('.takes')
    const headEl = root.querySelector('.takes__head')
    if (!takes || !headEl || headEl.dataset.dz) return
    headEl.dataset.dz = '1'

    const room = window.PROTO_ROOM
    const pct = room && room.quota ? Math.min(100, (room.usage / room.quota) * 100) : null

    headEl.innerHTML = `
      <div class="acct">
        <span class="acct__who">Not signed in</span>
        <span class="acct__av">${ic('user')}</span>
      </div>
      <div class="bar2">
        <div class="where" role="tablist">
          <button role="tab" aria-selected="true" data-where="device">${dic('device')}Device</button>
          <button role="tab" aria-selected="false" data-where="cloud">${dic('cloud')}Cloud</button>
        </div>
        <label class="find">${dic('search')}<input type="search" placeholder="Search takes" /></label>
        <div class="tools2">
          <button class="tool2" data-t="find" aria-pressed="false" title="Search">${dic('search')}</button>
          <button class="tool2" data-t="filter" aria-pressed="false" title="Filter">${dic('filter')}</button>
          <button class="tool2" data-t="sort" aria-pressed="false" title="Sort">${dic('sort')}</button>
          <button class="tool2" data-t="pick" aria-pressed="false" title="Select">${ic('check')}</button>
        </div>
      </div>
      ${
        pct === null
          ? ''
          : `<div class="room">
               <div class="room__bar"><div class="room__fill${pct > 85 ? ' is-tight' : ''}" style="width:${pct.toFixed(1)}%"></div></div>
               <div class="room__note"><b>${bytes(room.quota - room.usage)}</b> free of ${bytes(room.quota)} on this device</div>
             </div>`
      }`

    if (!takes.querySelector('.picked')) {
      const p = document.createElement('div')
      p.className = 'picked'
      p.innerHTML = `<span class="picked__n">0</span> selected
        <span class="picked__sp"></span>
        <button data-p="save">${ic('download')}Download</button>
        <button data-p="del" class="is-danger">${ic('trash')}Delete</button>`
      takes.appendChild(p)
    }
    wireHead(root, takes, headEl)
  }

  function wireHead(root, takes, headEl) {
    const bar = headEl.querySelector('.bar2')
    const input = headEl.querySelector('.find input')
    let openMenu = null

    const closeMenu = () => { if (openMenu) { openMenu.remove(); openMenu = null } }
    const menu = (btn, items, current, pick) => {
      closeMenu()
      const m = document.createElement('div')
      m.className = 'menu2'
      m.innerHTML = items.map((i) => `<button data-v="${i.id}" aria-checked="${i.id === current}">${ic('check')}${i.label}</button>`).join('')
      root.appendChild(m)
      const r = btn.getBoundingClientRect()
      const rr = root.getBoundingClientRect()
      m.style.left = Math.max(8, Math.min(r.left - rr.left - 60, rr.width - 170)) + 'px'
      m.style.top = r.bottom - rr.top + 6 + 'px'
      m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]')
        if (!b) return
        pick(b.dataset.v)
        closeMenu()
      })
      openMenu = m
    }

    const apply = () => {
      const q = (input.value || '').trim().toLowerCase()
      const list = takes.querySelector('.takes__list')
      const cards = [...takes.querySelectorAll('.takecard')]
      for (const c of cards) {
        const hay = (c.textContent || '').toLowerCase()
        const kinds = [...c.querySelectorAll('.kind')].map((k) => k.textContent.trim().toLowerCase())
        const okQ = !q || hay.includes(q)
        const okF = state.filter === 'all' || kinds.some((k) => k === state.filter)
        c.hidden = !(okQ && okF)
      }
      const key = {
        new: (c) => -cards.indexOf(c),
        old: (c) => cards.indexOf(c),
        big: (c) => -parseSize(c),
      }[state.sort]
      ;[...cards].sort((a, b) => key(a) - key(b)).forEach((c) => list.appendChild(c))
    }
    const parseSize = (c) => {
      const t = (c.querySelector('.takecard__size')?.textContent || '').trim()
      const n = parseFloat(t)
      return isNaN(n) ? 0 : n * (/gb/i.test(t) ? 1e9 : /mb/i.test(t) ? 1e6 : 1e3)
    }
    const state = { filter: 'all', sort: 'new' }

    bar.addEventListener('click', (e) => {
      const t = e.target.closest('[data-t]')
      const w = e.target.closest('[data-where]')
      if (w) {
        for (const b of bar.querySelectorAll('[data-where]')) b.setAttribute('aria-selected', String(b === w))
        // Cloud is signed out in this take, so it has nothing in it — say so
        // rather than showing the device's takes under a cloud tab.
        takes.classList.toggle('is-cloud', w.dataset.where === 'cloud')
        for (const c of takes.querySelectorAll('.takecard')) c.hidden = w.dataset.where === 'cloud'
        let empty = takes.querySelector('.cloud-empty')
        if (w.dataset.where === 'cloud') {
          if (!empty) {
            empty = document.createElement('div')
            empty.className = 'cloud-empty room__note'
            empty.style.padding = '18px 0'
            empty.style.textAlign = 'center'
            empty.textContent = 'Sign in to keep takes in the cloud.'
            takes.querySelector('.takes__list').after(empty)
          }
          empty.hidden = false
        } else if (empty) {
          empty.hidden = true
          apply()
        }
        return
      }
      if (!t) return
      const kind = t.dataset.t
      if (kind === 'find') {
        const on = bar.classList.toggle('is-finding')
        t.setAttribute('aria-pressed', String(on))
        if (on) input.focus()
        else { input.value = ''; apply() }
        return
      }
      if (kind === 'filter') {
        const kinds = new Set()
        for (const k of takes.querySelectorAll('.kind')) kinds.add(k.textContent.trim().toLowerCase())
        menu(
          t,
          [{ id: 'all', label: 'Every take' }, ...[...kinds].map((k) => ({ id: k, label: k.replace(/\b\w/g, (c) => c.toUpperCase()) }))],
          state.filter,
          (v) => { state.filter = v; t.setAttribute('aria-pressed', String(v !== 'all')); apply() },
        )
        return
      }
      if (kind === 'sort') {
        menu(t, SORTS, state.sort, (v) => { state.sort = v; t.setAttribute('aria-pressed', String(v !== 'new')); apply() })
        return
      }
      if (kind === 'pick') setPick(takes, !takes.classList.contains('is-picking'))
    })
    input.addEventListener('input', apply)
    root.addEventListener('pointerdown', (e) => { if (openMenu && !e.target.closest('.menu2') && !e.target.closest('[data-t]')) closeMenu() })
  }

  /* ---------- 4. select mode, and the drag that arms it ------------------
     Lifted from ~/Documents/inout copy (BEHAVIORS.md: app.js:8547 mouse,
     :3344 applyDragSelectRect, :3303 edge autoscroll). Its five decisions are
     the whole reason it feels right, and every one is kept:
       1. 200 ms hold before the drag arms — a tap still toggles one row and a
          scroll still scrolls.
       2. Direction comes from the row you started on: started picked =
          unpicking. The user never chooses a mode.
       3. Every row's state is snapshotted at drag start, so dragging past rows
          and back RESTORES them. Naive versions only sweep one way.
       4. Content coordinates, not screen — clientY - rect.top + scrollTop —
          or the selection drifts the moment the list autoscrolls.
       5. Held but never moved falls back to a plain toggle.
     It also auto-enters select mode, so there is no button to press first.
     The one thing NOT copied is the source's checkbox with no transition,
     which BEHAVIORS.md lists as a known oversight; the CSS gives it one. */
  const PICKED = new WeakMap()
  function setPick(takes, on) {
    takes.classList.toggle('is-picking', on)
    const btn = takes.querySelector('[data-t="pick"]')
    if (btn) btn.setAttribute('aria-pressed', String(on))
    if (!on) for (const c of takes.querySelectorAll('.takecard.is-picked')) c.classList.remove('is-picked')
    count(takes)
  }
  function count(takes) {
    const n = takes.querySelectorAll('.takecard.is-picked').length
    const el = takes.querySelector('.picked__n')
    if (el) el.textContent = String(n)
  }
  const scrollSurface = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n).overflowY
      if ((s === 'auto' || s === 'scroll') && n.scrollHeight > n.clientHeight + 4) return n
    }
    return el.closest('.takes__list') || el
  }

  function picking(root) {
    const takes = root.querySelector('.takes')
    if (!takes || takes.dataset.dzPick) return
    takes.dataset.dzPick = '1'

    let edgeTimer = null
    let lastY = 0
    const stopEdge = () => { if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null } }
    /* the accelerating curve IS the point — a constant speed feels broken */
    const edge = (surf) => {
      const r = surf.getBoundingClientRect()
      const zone = Math.max(56, r.height * 0.2)
      const max = surf.scrollHeight - surf.clientHeight
      let closeness = null
      let dir = 0
      if (lastY < r.top + zone) { closeness = lastY <= r.top ? 1 : 1 - (lastY - r.top) / zone; dir = -1 }
      else if (lastY > r.bottom - zone) { closeness = lastY >= r.bottom ? 1 : 1 - (r.bottom - lastY) / zone; dir = 1 }
      if (!dir) return false
      const step = 6 * (0.5 + 2.5 * Math.min(1, closeness))
      surf.scrollTop = Math.max(0, Math.min(max, surf.scrollTop + dir * step))
      return true
    }

    takes.addEventListener('pointerdown', (e) => {
      const card = e.target.closest('.takecard')
      if (!card) return
      const inLane = !!e.target.closest('.takecard__pick')
      if (!inLane && !takes.classList.contains('is-picking')) return
      if (e.target.closest('button, a, input') && !inLane) return

      const startY = e.clientY
      const st = { armed: false, moved: false, mode: null, from: null, startY: 0, surf: null }
      const move = (ev) => {
        lastY = ev.clientY
        if (!st.armed) return
        st.moved = true
        const surf = st.surf
        const r = surf.getBoundingClientRect()
        const nowY = ev.clientY - r.top + surf.scrollTop
        const top = Math.min(st.startY, nowY)
        const bot = Math.max(st.startY, nowY)
        for (const c of takes.querySelectorAll('.takecard')) {
          if (c.hidden) continue
          const cr = c.getBoundingClientRect()
          const cTop = cr.top - r.top + surf.scrollTop
          const overlaps = cTop + cr.height > top && cTop < bot
          const want = overlaps ? st.mode === 'select' : st.from.get(c) === true
          c.classList.toggle('is-picked', want)
        }
        count(takes)
        if (edge(surf)) { if (!edgeTimer) edgeTimer = setInterval(() => edge(surf), 16) }
        else stopEdge()
      }
      const end = () => {
        clearTimeout(timer)
        stopEdge()
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', end)
        if (st.armed && !st.moved) { card.classList.toggle('is-picked'); count(takes) }
        else if (!st.armed && takes.classList.contains('is-picking')) { card.classList.toggle('is-picked'); count(takes) }
      }
      const timer = setTimeout(() => {
        st.armed = true
        if (!takes.classList.contains('is-picking')) setPick(takes, true)
        st.mode = card.classList.contains('is-picked') ? 'deselect' : 'select'
        st.from = new Map()
        for (const c of takes.querySelectorAll('.takecard')) st.from.set(c, c.classList.contains('is-picked'))
        st.surf = scrollSurface(takes)
        st.startY = startY - st.surf.getBoundingClientRect().top + st.surf.scrollTop
      }, 200)
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', end)
    })

    takes.addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]')
      if (b && b.dataset.p === 'del') setPick(takes, false)
    })
  }

  /* ---------- 5. the quality rail ---------------------------------------- */
  function rail(root) {
    for (const qs of root.querySelectorAll('.qs')) {
      if (qs.dataset.dz) continue
      qs.dataset.dz = '1'
      const labels = [...qs.querySelectorAll('.qs__label')]
      const thumb = qs.querySelector('.qs__thumb')
      if (!labels.length || !thumb) continue
      /* The names sit in their own row BELOW the rail and each is absolutely
         placed at its stop's percentage, so narrowing the rail alone left them
         spread across the full width. Moving the row inside the rail is what
         makes "inside" true; the CSS then lays them out as equal segments. */
      const box = qs.querySelector('.qs__railbox')
      const row = qs.querySelector('.qs__labels')
      if (box && row && row.parentElement !== box) box.appendChild(row)
      const i = Math.max(0, labels.findIndex((l) => l.className.includes('qs__label--on')))
      const seg = 100 / labels.length
      thumb.style.setProperty('--seg', seg + '%')
      thumb.style.left = `calc(${(i * seg).toFixed(3)}% + 2px)`
      thumb.style.width = `calc(${seg.toFixed(3)}% - 4px)`
      // the chosen step's own size estimate, moved out from under the names
      const sub = labels[i]?.querySelector('.qs__label-sub')?.textContent?.trim()
      if (sub && !qs.querySelector('.qs__sub')) {
        const s = document.createElement('div')
        s.className = 'qs__sub'
        s.textContent = sub
        qs.querySelector('.qs__row')?.after(s)
      }
    }
  }

  window.applyDesign = function (root) {
    if (!root) return
    chips(root)
    cards(root)
    head(root)
    picking(root)
    rail(root)
  }
})()
