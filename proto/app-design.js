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
  /* app-sim.js positions the shipping rail's thumb and must not fight this
     file's segmented one. It asks for this flag rather than for a <style id>,
     which exists in both tabs (empty in the shipping one) and answered wrong. */
  window.PROTO_DESIGN = true
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
  const nameOf = (b) => (b.getAttribute('title') || b.textContent || '').trim().toLowerCase()

  /* the glyph the app already uses for this action, taken off the element that
     uses it; the sprite name is only the fallback for a screen with no cards */
  const glyphOf = (root, sel, fallback) => root.querySelector(sel + ' svg')?.outerHTML || ic(fallback)

  const bytes = (n) =>
    n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB'

  /* ---------- 1. the input chips: neon's glyph, the app's colour ---------- */
  /* The two things that come off ONE surface stand together: a screen share and
     the sound of that tab are the same decision, so tab audio moves up beside
     the screen chip and the two devices follow. */
  const CHIP_ORDER = ['screen', 'tab audio', 'camera', 'mic']
  function chips(root) {
    const row = root.querySelector('.chips')
    if (row && !row.dataset.dzOrder) {
      row.dataset.dzOrder = '1'
      const by = new Map([...row.querySelectorAll('.chip')].map((c) => [nameOf(c), c]))
      for (const k of CHIP_ORDER) if (by.has(k)) row.appendChild(by.get(k))
    }
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

      /* and the opposite corner says whether there is a copy of it in the
         cloud — the one fact that decides whether this card can be sent or
         linked at all. The mark is on every card and CSS shows it on the ones
         app-sim.js has stamped, so the state can change without touching DOM. */
      if (thumb && !thumb.querySelector('.cloudmark')) {
        const c = document.createElement('span')
        c.className = 'cloudmark'
        c.title = 'Kept in the cloud as well as on this computer'
        c.innerHTML = dic('cloud')
        thumb.appendChild(c)
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
      const btns = [...card.querySelectorAll('.takecard__actions .takecard__btn')]
      for (const b of btns) {
        const t = (b.textContent || '').trim().toLowerCase()
        if (t === 'watch' || t === 'edit') b.remove()
      }
      /* Download, Show in folder and Delete are one group in the corner, in that
         order. They are icon-only there, so each keeps its name where a name is
         still needed — the tooltip and the accessible label. */
      const del = card.querySelector('.takecard__del')
      if (del && !card.querySelector('.cardtools')) {
        const tools = document.createElement('div')
        tools.className = 'cardtools'
        for (const want of ['download', 'show in folder']) {
          const b = btns.find((x) => (x.textContent || '').trim().toLowerCase() === want)
          if (!b) continue
          const label = (b.textContent || '').trim()
          b.title = label
          b.setAttribute('aria-label', label)
          for (const sp of b.querySelectorAll('span')) sp.remove()
          tools.appendChild(b)
        }
        del.replaceWith(tools)
        tools.appendChild(del)
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
      <div class="bar2">
        <!-- FILTER AND SORT NARROW THE LIST, WHICH IS WHAT THE SEARCH DOES,
             so they sit with it rather than in the row below. That leaves the
             row below to say one thing only: what is selected, or how much
             there is. -->
        <div class="findrow">
          <label class="find">${dic('search')}<input type="search" placeholder="Search takes" /></label>
          <span class="normx">
            <button class="tool2" data-t="filter" aria-pressed="false" title="Filter">${dic('filter')}</button>
            <button class="tool2" data-t="sort" aria-pressed="false" title="Sort">${dic('sort')}</button>
          </span>
        </div>
        <div class="rightgrp">
          <div class="where" role="tablist">
            <button role="tab" aria-selected="true" data-where="device">${dic('device')}Device</button>
            <button role="tab" aria-selected="false" data-where="cloud">${dic('cloud')}Cloud</button>
          </div>
          <button class="acct__av" data-acct title="Not signed in">${ic('user')}</button>
        </div>
        <!-- THE SELECT TOGGLE IS A CHECKBOX AND IT LEADS THE ROW. It is the
             same box the cards wear, so pressing it and ticking a take are
             plainly the same object; and All / Clear slide out from behind it
             the way ~/Documents/inout copy does it (index.html:681 Select,
             select-extra All + None; styles.css:1122 the slide). Its word for
             the second one is None, his is Clear, and his wins. -->
        <div class="tools2">
          <button class="tool2 tool2--pick" data-t="pick" aria-pressed="false" title="Select takes">
            <span class="pick">${ic('check')}</span>
          </button>
          <span class="selx">
            <button class="tool2 tool2--txt" data-p="all">All</button>
            <button class="tool2 tool2--txt" data-p="clear">Clear</button>
          </span>
          <span class="totalx"><b class="total__n">0</b><span class="total__w">takes</span></span>
        </div>
        ${
          pct === null
            ? '<div class="room"></div>'
            : `<div class="room">
                 <div class="room__bar"><div class="room__fill${pct > 85 ? ' is-tight' : ''}" style="width:${pct.toFixed(1)}%"></div></div>
                 <div class="room__note"><b>${bytes(room.quota - room.usage)}</b> free of ${bytes(room.quota)}</div>
               </div>`
        }
      </div>`

    /* WHAT YOU DO WITH A SELECTION GOES BESIDE THE BUTTON THAT STARTED IT.
       It was a panel that slid in under the list — a second place to look for
       the answer to a press you just made two rows up. In the tool group it is
       one row: the checkbox, what it selects, then what you do with them. */
    if (!takes.querySelector('.picked')) {
      const p = document.createElement('div')
      p.className = 'picked'
      /* Icon-only, because by then the row already carries three words and a
         number, and these two are the same KIND of press as the icon group in
         each card's corner — they keep their name in the tooltip and the label.
         AND THEY ARE THE CARD'S OWN GLYPHS, CLONED. Download and Delete are
         already drawn two inches below this row by the app's icon set; reaching
         into the neon sprite for them here put a second download arrow and a
         second bin on the same screen doing the same job. cards() runs before
         head(), so the corner group is there to copy from and the two can never
         drift apart. */
      p.innerHTML = `<span class="picked__n">0</span> selected
        <button data-p="save" title="Download" aria-label="Download">${glyphOf(root, '.cardtools [title="Download"]', 'download')}</button>
        <button data-p="del" class="is-danger" title="Delete" aria-label="Delete">${glyphOf(root, '.cardtools .takecard__del', 'trash')}</button>`
      headEl.querySelector('.tools2').appendChild(p)
    }
    total(takes)
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
      total(takes)
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
        /* THE CLOUD TAB IS THE SAME LIST, FILTERED. Device shows everything
           kept on this computer; Cloud shows the takes that also have a copy up
           there — the ones that carry Send and Copy link. It says the empty
           thing only when there is genuinely nothing to show. */
        const onCloud = w.dataset.where === 'cloud'
        takes.classList.toggle('is-cloud', onCloud)
        let n = 0
        for (const c of takes.querySelectorAll('.takecard')) {
          const keep = !onCloud || c.dataset.cloud === '1'
          c.hidden = !keep
          if (onCloud && keep) n++
        }
        let empty = takes.querySelector('.cloud-empty')
        if (onCloud) {
          if (!empty) {
            empty = document.createElement('div')
            empty.className = 'cloud-empty room__note'
            empty.style.padding = '18px 0'
            empty.style.textAlign = 'center'
            takes.querySelector('.takes__list').after(empty)
          }
          empty.textContent = cloudNote()
          empty.hidden = n > 0
        } else if (empty) {
          empty.hidden = true
          apply()
        }
        return
      }
      /* All and Clear, as ~/Documents/inout copy has them (app.js:12518 and
         :12534): All ticks everything the list is currently showing — a search
         or a filter is the set you meant — and Clear empties the selection but
         STAYS in select mode. Only the checkbox itself leaves the mode. */
      const p = e.target.closest('[data-p]')
      if (p && (p.dataset.p === 'all' || p.dataset.p === 'clear')) {
        const want = p.dataset.p === 'all'
        for (const c of takes.querySelectorAll('.takecard')) {
          if (want && c.hidden) continue
          c.classList.toggle('is-picked', want)
        }
        count(takes)
        return
      }
      if (!t) return
      const kind = t.dataset.t
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
    /* WHAT YOU DO WITH A SELECTION ARRIVES WITH THE SELECTION, not with the
       mode. Entering select mode opens All and Clear; picking something opens
       the count and its two buttons, to the right of the library count, which
       never moves. Three things in the row, each turning up when it has
       something to say. */
    takes.classList.toggle('has-picked', n > 0)
  }
  /* WITH NOTHING SELECTED THE ROW SAYS HOW MUCH THERE IS. It was empty next to
     the checkbox, and the number belongs there: it is the same row that counts
     the selection, counting the whole list instead. When a search or a filter
     is narrowing the list it says both, because "3 takes" while eleven are put
     away is a lie the storage bar underneath would contradict. */
  function total(takes) {
    const n = takes.querySelector('.total__n')
    const w = takes.querySelector('.total__w')
    if (!n || !w) return
    const all = takes.querySelectorAll('.takecard').length
    const shown = [...takes.querySelectorAll('.takecard')].filter((c) => !c.hidden).length
    n.textContent = shown === all ? String(all) : `${shown} of ${all}`
    w.textContent = all === 1 && shown === all ? 'take' : 'takes'
  }
  /* THE LIST IS INSIDE .takes, NOT ABOVE IT. This walked only upward, found
     nothing that scrolls, and fell back to `el.closest('.takes__list')` — which
     is null, because closest looks at ancestors and the list is a child. So the
     surface came back as .takes itself, an element with no overflow, and the
     edge autoscroll spent every frame moving a scrollTop that does not exist:
     a drag simply stopped dead at the last visible row. Look down first. */
  const canScroll = (n) => {
    if (!n) return false
    const s = getComputedStyle(n).overflowY
    return (s === 'auto' || s === 'scroll') && n.scrollHeight > n.clientHeight + 4
  }
  const scrollSurface = (el) => {
    const list = el.querySelector('.takes__list')
    if (canScroll(list)) return list
    for (let n = el; n && n !== document.body; n = n.parentElement) if (canScroll(n)) return n
    return list || el
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
      /* HOLD ANYWHERE ON THE ROW TO ENTER SELECT MODE. The source hangs this on
         the checkbox rail (app.js:8547, checkboxZone mousedown) and can, because
         its rail is on every row all the time. Ours is not — the boxes slide in
         when the mode turns on, which is the point of them — so there is no rail
         to hold and the row itself is the grab. Every control on the card is
         still excluded, so the only thing a hold can land on is the card's own
         text and the empty space beside it; a press on the picture opens the
         take exactly as before. This guard used to demand the lane and the lane
         was display:none, so the gesture could never fire at all. */
      const inLane = !!e.target.closest('.takecard__pick')
      if (e.target.closest('button, a, input') && !inLane) return

      const startY = e.clientY
      const st = { armed: false, moved: false, mode: null, from: null, startY: 0, surf: null }
      /* Sweep the rect over the rows, from lastY rather than from an event, so
         the EDGE TIMER can call it too: while the pointer is held still at the
         bottom of the list the rows scrolling up under it have to keep joining
         the selection, which is the whole point of the autoscroll. */
      const applyRect = () => {
        const surf = st.surf
        const r = surf.getBoundingClientRect()
        /* the proto draws the app inside a scaled frame, so a rect is in
           scaled pixels while scrollTop is not: divide the scale out or the
           selection drifts away from the pointer the moment the list moves */
        const z = surf.offsetHeight ? r.height / surf.offsetHeight : 1
        const nowY = (lastY - r.top) / z + surf.scrollTop
        const top = Math.min(st.startY, nowY)
        const bot = Math.max(st.startY, nowY)
        for (const c of takes.querySelectorAll('.takecard')) {
          if (c.hidden) continue
          const cr = c.getBoundingClientRect()
          const cTop = (cr.top - r.top) / z + surf.scrollTop
          const overlaps = cTop + cr.height / z > top && cTop < bot
          const want = overlaps ? st.mode === 'select' : st.from.get(c) === true
          c.classList.toggle('is-picked', want)
        }
        count(takes)
      }
      const move = (ev) => {
        lastY = ev.clientY
        if (!st.armed) return
        st.moved = true
        applyRect()
        const surf = st.surf
        if (edge(surf)) {
          if (!edgeTimer) edgeTimer = setInterval(() => { if (edge(surf)) applyRect(); else stopEdge() }, 16)
        } else stopEdge()
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
        /* is-picking brings user-select:none with it, but only from here on —
           the 200 ms before it belongs to the browser, and a hold that begins on
           the date leaves that text highlighted behind the sweep. Drop it. */
        try { window.getSelection()?.removeAllRanges() } catch (err) { /* not worth a throw */ }
        if (!takes.classList.contains('is-picking')) setPick(takes, true)
        st.mode = card.classList.contains('is-picked') ? 'deselect' : 'select'
        st.from = new Map()
        for (const c of takes.querySelectorAll('.takecard')) st.from.set(c, c.classList.contains('is-picked'))
        st.surf = scrollSurface(takes)
        const sr = st.surf.getBoundingClientRect()
        const sz = st.surf.offsetHeight ? sr.height / st.surf.offsetHeight : 1
        st.startY = (startY - sr.top) / sz + st.surf.scrollTop
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

  /* one sentence for an empty cloud, and it names the reason it is empty */
  const cloudNote = () =>
    (window.PROTO_SIM || {}).account === 'in'
      ? 'Nothing kept in the cloud yet — Send a take to put it there.'
      : 'Sign in to keep takes in the cloud.'

  /* the account button and the cloud tab both read the same switch */
  function account(root) {
    const sim = window.PROTO_SIM || {}
    const inAcct = sim.account === 'in'
    const av = root.querySelector('[data-acct]')
    if (av) {
      av.classList.toggle('is-in', inAcct)
      av.title = inAcct ? 'Signed in as robmakarov23@gmail.com' : 'Not signed in'
      if (inAcct) av.textContent = 'RM'
      else av.innerHTML = ic('user')
    }
    const empty = root.querySelector('.cloud-empty')
    if (empty) empty.textContent = cloudNote()
  }

  /* ---------- the studio motion, copied from proto/style.html --------------
     initBgGridPointerTilt: the grid leans toward the pointer (lerp .11, +-10px).
     initElasticHubScroll:  a wheel notch injects velocity into a damped spring
     that moves the screen and drags the grid behind it. The five numbers that
     decide how it feels live on PHYS so the panel can move them mid-flight;
     style.html's values are the defaults, so the two protos feel the same. */
  const PHYS = { k: 344, c: 25.5, imp: 4.4, follow: 0.31, wall: 0.14 }
  const GRID = { k: 0.7, cell: 24, on: true }
  const BOUNCE = { on: true }

  function gridImage() {
    // one path, stroked once per tile — see the note in the stylesheet
    const a = (0.075 * GRID.k).toFixed(4)
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">' +
      // half-pixel offsets: a stroke centred on the tile edge is half-covered,
      // so the corner is the union of two half-covered bands and reads brighter
      // than the lines. Inset to 23.5 and every pixel gets full coverage.
      '<path d="M23.5 0V24M0 23.5H24" fill="none" stroke="rgba(255,255,255,' + a + ')" stroke-width="1"/></svg>'
    const app = document.getElementById('app')
    if (!app) return
    app.style.setProperty('--grid-img', GRID.on ? 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")' : 'none')
    app.style.setProperty('--grid-k', String(GRID.k))
    app.style.setProperty('--grid-cell', GRID.cell + 'px')
    /* WITH THE GRID ON, THE APP'S OWN BACKGROUND GETS OUT OF THE WAY. The app
       paints a near-black over the whole frame; the grid is the ground when it
       is on, and a ground under a ground is just a flatter ground. */
    app.dataset.grid = GRID.on ? 'on' : 'off'
  }

  function motion(root) {
    if (!root.querySelector('.dzgrid')) {
      const g = document.createElement('div')
      g.className = 'dzgrid'
      root.insertBefore(g, root.firstChild)
    }
    gridImage()
    if (root.dataset.dzMotion) return
    root.dataset.dzMotion = '1'

    const BG_LERP = 0.11
    const BG_SHIFT_MAX_PX = 10
    let curX = 0, curY = 0, tgtX = 0, tgtY = 0, tiltRaf = 0
    function tiltTick() {
      tiltRaf = 0
      curX += (tgtX - curX) * BG_LERP
      curY += (tgtY - curY) * BG_LERP
      root.style.setProperty('--tilt-x', curX.toFixed(5))
      root.style.setProperty('--tilt-y', curY.toFixed(5))
      root.style.setProperty('--bg-shift-x', (curX * BG_SHIFT_MAX_PX).toFixed(2) + 'px')
      root.style.setProperty('--bg-shift-y', (curY * BG_SHIFT_MAX_PX).toFixed(2) + 'px')
      if (Math.abs(tgtX - curX) > 0.0008 || Math.abs(tgtY - curY) > 0.0008) tiltRaf = requestAnimationFrame(tiltTick)
    }
    root.addEventListener('mousemove', (e) => {
      const r = root.getBoundingClientRect()
      tgtX = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1))
      tgtY = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1))
      if (!tiltRaf) tiltRaf = requestAnimationFrame(tiltTick)
    })

    const pixelDeltaBoost = 1.72
    const velCap = 5200
    const edgePad = 2
    let posX = 0, posY = 0, velX = 0, velY = 0, physRaf = null, lastT = 0
    const cluster = () => root.querySelector('.capture')
    // the spring belongs to the waiting screen, not to a running take: once the
    // stage is up the controls are a bar and must not drift off it
    const live = () => BOUNCE.on && !!cluster() && !root.querySelector('.stage')
    /* THE ONE ADAPTATION FROM style.html, AND IT HAD TO BE MADE. There the
       cluster is a small centred group, so the room around it IS the travel and
       the maths is scale-proof. Here the cluster is the whole record screen and
       fills the frame, so that derivation came out zero and the spring settled
       before it moved — the throw did nothing at all. A screen that fills its
       frame gets a fixed elastic overscroll instead; a cluster with real room
       around it still uses that room, capped so it never sails off. */
    const TRAVEL_CAP = 48
    function bounds() {
      const c = cluster()
      if (!c) return { maxX: 0, maxY: 0 }
      const roomX = (root.clientWidth - c.offsetWidth) / 2 - edgePad
      const roomY = (root.clientHeight - c.offsetHeight) / 2 - edgePad
      return {
        maxX: roomX > 0 ? Math.min(roomX, TRAVEL_CAP) : TRAVEL_CAP,
        maxY: roomY > 0 ? Math.min(roomY, TRAVEL_CAP) : TRAVEL_CAP,
      }
    }
    function apply(x, y) {
      posX = x
      posY = y
      const c = cluster()
      if (!c) return
      if (Math.abs(x) < 0.02 && Math.abs(y) < 0.02) {
        c.style.transform = ''
        root.style.removeProperty('--bump-x')
        root.style.removeProperty('--bump-y')
      } else {
        c.style.transform = 'translate3d(' + x.toFixed(2) + 'px, ' + y.toFixed(2) + 'px, 0)'
        root.style.setProperty('--bump-x', (x * PHYS.follow).toFixed(2) + 'px')
        root.style.setProperty('--bump-y', (y * PHYS.follow).toFixed(2) + 'px')
      }
    }
    function rest() {
      posX = posY = velX = velY = 0
      lastT = 0
      const c = cluster()
      if (c) c.style.transform = ''
      root.style.removeProperty('--bump-x')
      root.style.removeProperty('--bump-y')
    }
    function step(t) {
      physRaf = null
      if (!lastT) lastT = t
      let dt = (t - lastT) / 1000
      lastT = t
      if (dt > 0.055) dt = 0.055
      if (dt <= 0) dt = 1 / 60
      velX += (-PHYS.k * posX - PHYS.c * velX) * dt
      velY += (-PHYS.k * posY - PHYS.c * velY) * dt
      posX += velX * dt
      posY += velY * dt
      const b = bounds()
      if (posX > b.maxX) { posX = b.maxX; velX *= -PHYS.wall }
      else if (posX < -b.maxX) { posX = -b.maxX; velX *= -PHYS.wall }
      if (posY > b.maxY) { posY = b.maxY; velY *= -PHYS.wall }
      else if (posY < -b.maxY) { posY = -b.maxY; velY *= -PHYS.wall }
      if (Math.hypot(posX, posY) < 0.55 && Math.hypot(velX, velY) < 6) return rest()
      apply(posX, posY)
      physRaf = requestAnimationFrame(step)
    }
    const kick = () => { if (physRaf == null) physRaf = requestAnimationFrame(step) }
    const norm = (d, mode) => (mode === 1 ? d * 16 : mode === 2 ? d * Math.min(900, root.clientHeight * 0.85) : d * pixelDeltaBoost)
    root.addEventListener(
      'wheel',
      (e) => {
        if (!live()) return
        /* A WHEEL OVER THE TAKES LIST SCROLLS THE LIST. The spring owns the
           screen's empty space, not a scrollable thing inside it — otherwise the
           feed can never be reached with the wheel at all. */
        const list = e.target.closest && e.target.closest('.takes__list')
        if (list && list.scrollHeight > list.clientHeight + 2) return
        const dx = norm(e.deltaX, e.deltaMode)
        const dy = norm(e.deltaY, e.deltaMode)
        if (!dx && !dy) return
        e.preventDefault()
        e.stopPropagation()
        velX += -dx * PHYS.imp
        velY += -dy * PHYS.imp
        const sp = Math.hypot(velX, velY)
        if (sp > velCap) { velX *= velCap / sp; velY *= velCap / sp }
        kick()
      },
      { passive: false, capture: true },
    )
    // moving to another screen puts it back on its seat, mid-flight
    window.addEventListener('protoscreen', () => { if (physRaf != null) cancelAnimationFrame(physRaf); physRaf = null; rest() })
  }

  /* the panel drives these; the proto keeps style.html's names for them */
  window.protoMotion = {
    phys: PHYS,
    grid: GRID,
    bounce: BOUNCE,
    set(key, value) {
      if (key in PHYS) PHYS[key] = +value
      else if (key === 'gridk') GRID.k = +value
      else if (key === 'gridcell') GRID.cell = +value
      else if (key === 'gridon') GRID.on = !!value
      else if (key === 'bounceon') BOUNCE.on = !!value
      gridImage()
    },
  }

  window.applyDesign = function (root) {
    if (!root) return
    chips(root)
    cards(root)
    motion(root)
    head(root)
    account(root)
    picking(root)
    rail(root)
  }
})()
