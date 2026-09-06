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
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
  }
  const dic = (n) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DRAWN[n]}</svg>`
  /* the app names its inputs; neon draws them. One map, used by the chips and
     by the little kind badges on a card, so the two can never drift apart. */
  const GLYPH = { screen: 'display', camera: 'camera', mic: 'mic', 'tab audio': 'waves', 'system audio': 'waves', sound: 'waves' }
  const glyphFor = (label) => GLYPH[String(label || '').trim().toLowerCase()] || 'display'
  /* and the same for what a button DOES, so every action in the frame is drawn
     by one hand. Keyed on the app's own wording — its text, or its label when
     it has none — so a button the app renames simply stops matching rather than
     quietly getting the wrong picture. */
  const ACTION = {
    download: 'download',
    'show in folder': 'folder',
    send: 'send',
    'copy link': 'link',
    'make a link': 'link',
    watch: 'play',
    edit: 'scissors',
  }
  /* THE BIN IS NOT IN THAT MAP AND THAT IS DELIBERATE (Robert, 2026-09-06:
     "bring back previous trash icon"). The app draws its own and it is the
     better bin; the sprite's is not. So the delete button keeps what it came
     with, and the toolbar's delete is cloned off it, which is how the two stay
     the same drawing without either of them being redrawn here. */
  const nameOf = (b) => (b.getAttribute('title') || b.textContent || '').trim().toLowerCase()

  /* the glyph the app already uses for this action, taken off the element that
     uses it; the sprite name is only the fallback for a screen with no cards */
  const glyphOf = (root, sel, fallback) => root.querySelector(sel + ' svg')?.outerHTML || ic(fallback)

  /* THE MONTH IS SPELLED OUT (Robert, 2026-09-06). The app abbreviates it
     because its date shares a line with three other facts; here the date has
     its own end of a row and nothing is fighting it for the space, and a word
     is read where an abbreviation is decoded. Written on whatever the app
     handed over, so a locale that already spells it out passes through. */
  const MONTHS = {
    jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
    jul: 'July', aug: 'August', sep: 'September', sept: 'September', oct: 'October',
    nov: 'November', dec: 'December',
  }
  const month = (s) =>
    String(s || '').replace(/\b([A-Za-z]{3,4})\.?\b/g, (w, k) => MONTHS[k.toLowerCase()] || w)

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

      /* THE PREVIEW IS NOT DRAGGABLE. Chrome makes every <img> a drag source,
         so pulling down a card to sweep a selection picked the picture up and
         carried a ghost of it around instead — and a stray drag out of the
         window is not something a take list should ever offer. */
      const im = thumb && thumb.querySelector('img')
      if (im) im.draggable = false

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

      /* The full date and time, stamped onto the frozen card from the take's
         own record at capture time — the app's own label is only a clock.
         AND IT IS TWO FACTS, NOT ONE STRING (Robert, 2026-09-06): the DAY is
         how you find the take and the TIME is how you tell two of them apart,
         so they are separate spans and the comma between them goes — a gap
         says the same thing without a mark on the line. */
      const when = card.querySelector('.takecard__when')
      if (when && !when.querySelector('.wdate')) {
        const full = ((when.dataset.whenFull || when.textContent) || '').trim()
        const m = full.match(/^(.*?)[,\s]*(\d{1,2}:\d{2}(?::\d{2})?)$/)
        const span = (cls, txt) => {
          const s = document.createElement('span')
          s.className = cls
          s.textContent = txt
          return s
        }
        when.textContent = ''
        when.append(span('wdate', month(m ? m[1] : full)))
        if (m) when.append(span('wtime', m[2]))
      }

      /* THE FILE HAS A NAME AND THE CARD SAYS IT. The take was a thing with a
         date on it and no identity; the name is what you will look for in a
         Downloads folder, so it goes first and everything else steps under it.
         Empty means the app names it, and the placeholder is that name — the
         real one, stamped off the take's own createdAt at capture time by the
         rule in src/core/compose/fileName.ts, not a guess made from the clock
         on the card. Type and it is yours; click away and it is kept. */
      const body = card.querySelector('.takecard__body')
      if (body && !body.querySelector('.takename')) {
        /* NO EXTENSION IN THE FIELD. What you name is the file, not the
           container it is written in — .mp4 is the app's business, the way it
           is Finder's when you rename something there. The stem is what shows;
           the extension is put back wherever a real filename is meant. */
        const auto = ((when && when.dataset.autoName) || '').replace(/\.[a-z0-9]+$/i, '')
        const ext = (((when && when.dataset.autoName) || '').match(/\.[a-z0-9]+$/i) || ['.mp4'])[0]
        const inp = document.createElement('input')
        inp.type = 'text'
        inp.className = 'takename'
        inp.spellcheck = false
        inp.placeholder = auto
        inp.setAttribute('aria-label', 'Name this file')
        inp.title = auto ? `Named ${auto}${ext} unless you say otherwise` : 'Name this file'
        card.dataset.autoName = auto
        card.dataset.ext = ext
        body.insertBefore(inp, body.firstChild)
      }

      /* The inputs it used, as the chips in miniature — and they are the FIRST
         line now, with the name under them (Robert, 2026-09-06; they and the
         name traded places). What a take is made of is what your eye catches
         from across the list, and it is the one thing on the card that is a
         picture rather than words; the name is what you read once you have
         found the row, and the date is the footnote under both.

         THE QUALITY AND THE SIZE LEAD THE LAST ROW (Robert, 2026-09-06). They
         went up beside the inputs first and came back down: what a take is MADE
         OF is one sentence, and how good it came out, how big it is and when it
         happened are another — the facts you sort by. So the last line reads
         quality, size, then the date, and the size is a tag now like the two
         beside it rather than loose text between them. */
      const kinds = card.querySelector('.takecard__kinds')
      if (kinds && !kinds.querySelector('.kind')) {
        const names = kinds.textContent.split('·').map((s) => s.trim()).filter(Boolean)
        kinds.innerHTML = names.map((n) => `<span class="kind">${ic(glyphFor(n))}${n}</span>`).join('')
        if (body) body.insertBefore(kinds, body.firstChild)
      }
      const step = card.querySelector('.takecard__step')
      const size = card.querySelector('.takecard__size')
      if (when && step && size && when.previousElementSibling !== size) {
        when.parentElement.insertBefore(step, when)
        when.parentElement.insertBefore(size, when)
      }

      /* ONE ICON SET IN THE FRAME. The chips and the kind badges already wear
         neon's; the card's own buttons still wore the app's, drawn at a
         different stroke — so a download arrow in the card corner and a
         download arrow in the toolbar were two different drawings of the same
         idea. Same sprite for all of them, and the toolbar's pair is cloned off
         this one, so there is exactly one place the choice is made. */
      const btns = [...card.querySelectorAll('.takecard__actions .takecard__btn')]
      for (const b of [...btns, card.querySelector('.takecard__del')]) {
        if (!b) continue
        const name = ACTION[(b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase()]
        const svg = name && b.querySelector('svg')
        if (svg) svg.outerHTML = ic(name)
      }

      // Watch and Edit go; the picture itself already opens the take
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

  /* ---------- 2b. WATCH IT WHERE IT IS ------------------------------------
     Robert, 2026-09-06: "when card clicked preview image animation transform to
     watch video that push away cards and its card content and fills height, top
     bar and tool bar follows its width."

     THE PICTURE YOU PRESSED IS THE PLAYER. A take is a video and the card
     already shows a frame of it, so opening one should not be a cut to another
     screen with a different picture in a different place — the frame grows into
     the thing you watch and the feed steps out from under it. The card's own
     name and tags leave with the feed: beside a picture that size they are a
     caption on a photograph.

     THE FRAME GIVES THE HEIGHT AND THE TAKE GIVES THE WIDTH. The player fills
     the room between the head and the control bar; its width follows from the
     take's own shape — a phone take is a tall one and gets a narrow player —
     and then --take-w, the one token the head, the feed and the control bar
     already share, is set to that width. So the app widens around the video
     instead of the video sitting in a column that was sized for a list. */
  const WATCH = { root: null, card: null, box: null, from: null, at: null, playAt: null, playW: '', ratio: 16 / 9, timer: 0 }
  /* WHERE THE PICTURE GOES, GIVEN THE FRAME AS IT IS NOW. Close under the bar
     it belongs to (the head names the take it is showing) and clear of the one
     it does not (the control bar is the app's own furniture and wants the
     room). Asked again whenever the frame changes under it — pressing Edit
     grows the bar, and the answer is a different box, not a guess. */
  function playerBox(root, ratio) {
    const cap = root.querySelector('.capture')
    const takes = root.querySelector('.takes')
    const headEl = takes && takes.querySelector('.takes__head')
    const bar = root.querySelector('.controlbar')
    if (!cap || !headEl) return null
    const capR = cap.getBoundingClientRect()
    const headR = headEl.getBoundingClientRect()
    const barTop = bar ? bar.getBoundingClientRect().top : capR.bottom
    const padTop = 8
    const padBottom = 30
    const padSide = 14
    const top = headR.bottom + padTop
    const room = Math.max(120, barTop - padBottom - top)
    let h = room
    let w = h * ratio
    const maxW = capR.width - 2 * padSide
    if (w > maxW) {
      w = maxW
      h = w / ratio
    }
    return [(capR.width - w) / 2, top - capR.top + (room - h) / 2, w, h]
  }
  const boxAt = (el, x, y, w, h) => {
    el.style.left = Math.round(x) + 'px'
    el.style.top = Math.round(y) + 'px'
    el.style.width = Math.round(w) + 'px'
    el.style.height = Math.round(h) + 'px'
  }

  function watchOpen(root, card) {
    if (WATCH.card || !card) return
    const takes = root.querySelector('.takes')
    const cap = root.querySelector('.capture')
    const thumb = card.querySelector('.takecard__thumb')
    const img = thumb && thumb.querySelector('img')
    const headEl = takes && takes.querySelector('.takes__head')
    if (!takes || !cap || !img || !headEl) return
    const r0 = thumb.getBoundingClientRect()
    const ratio = r0.height ? r0.width / r0.height : 16 / 9

    clearTimeout(WATCH.timer)
    WATCH.root = root
    WATCH.card = card
    /* built BEFORE the state lands, so it has a frame to start its entrance
       from — created inside .is-watch it would already be in its final place */
    watchBar(root, takes, card)
    void takes.offsetHeight
    takes.classList.add('is-watch')
    card.classList.add('is-watching')

    /* THE ROOM IS THE ROOM THE APP ALREADY HAS — between the head and the
       control bar, both of which stay exactly where they are. Nothing is
       stretched to make space; the picture floats in what is there. */
    const capR = cap.getBoundingClientRect()

    const box = document.createElement('div')
    box.className = 'watchbox'
    box.innerHTML =
      `<img alt="" src="${img.currentSrc || img.src}">` +
      `<span class="watchplay">${ic('play')}</span>`
    const dur = thumb.querySelector('.dur')
    if (dur) box.appendChild(dur.cloneNode(true))
    cap.appendChild(box)
    WATCH.box = box
    /* THE SLOT IT CAME OUT OF, KEPT. It is also where it goes home to: the
       layout behind the player never changes, so the rect measured here is
       still true when it comes back — and measuring it again on the way out
       read the bars mid-transition and sent the picture to a place the card
       was only passing through, which is what made the return look broken. */
    WATCH.from = [r0.left - capR.left, r0.top - capR.top, r0.width, r0.height]
    /* the flight: it starts as the card's own picture, to the pixel */
    boxAt(box, ...WATCH.from)
    void box.offsetWidth
    box.classList.add('is-open')
    WATCH.ratio = ratio
    WATCH.at = playerBox(root, ratio)
    boxAt(box, ...WATCH.at)
    /* the frame the picture plays in, kept: shutting the drawer puts it back
       rather than measuring a second time for an answer already known */
    WATCH.playAt = WATCH.at
    WATCH.playW = Math.max(420, Math.round(WATCH.at[2])) + 'px'
    /* THE FRAME IS THE PICTURE'S WIDTH, EXACTLY (Robert, 2026-09-06: "make bars
       and bg cards meny resize with play window when edit bar comes, make edit
       bar same width as play window"). The head, the feed and the control bar
       all read --take-w, so one number makes the whole app the width of the
       take being played — and when the timeline takes height off the picture,
       everything narrows with it. The floor is only there so the head's own row
       has somewhere to stand; nothing normal reaches it. */
    root.style.setProperty('--take-w', WATCH.playW)
    watchDock(root)
  }

  /* THE HEAD IS THE PLAYER'S BAR WHILE IT PLAYS (Robert, 2026-09-06: "top bar
     replaced with animation with play window top bar, on left name input, on
     right button group with controls, icons+text, to the right of them cross to
     close play window").

     Searching, sorting and choosing between Device and Cloud are questions
     about a LIST, and there is no list in front of you while a take is playing
     — so that row leaves through the top and the take's own row comes up from
     under it, in the head's own box, at the head's own height. Nothing about
     the take is re-drawn for it: the name is the card's field and the buttons
     are the card's buttons, wearing their names out loud because there is room
     for words here and there was none in a card corner. */
  /* the button's OWN word first — Send and Copy link carry theirs in a span and
     their title is "Not wired up yet", which is a state, not a name. The corner
     tools have no words at all, so theirs come from the label they are read out
     by, with the file name the download button promises trimmed back off. */
  const BTN_LABEL = (b) => {
    if (b.classList.contains('takecard__del')) return 'Delete'
    const own = (b.querySelector('span') ? b.querySelector('span').textContent : '').trim()
    if (own) return own
    const raw = b.dataset.dlBase || b.getAttribute('aria-label') || b.getAttribute('title') || ''
    return raw.split(' — ')[0].trim() || 'Open'
  }
  function watchBar(root, takes, card) {
    const headEl = takes.querySelector('.takes__head')
    if (!headEl) return
    const old = headEl.querySelector('.watchbar')
    if (old) old.remove()

    const bar = document.createElement('div')
    bar.className = 'watchbar'
    const row = document.createElement('div')
    row.className = 'wrow'

    /* the name is a copy of the card's field, and what you type in it is typed
       into the card's: one name, two places to reach it */
    const src = card.querySelector('.takename')
    if (src) {
      const inp = src.cloneNode(true)
      inp.classList.add('watchname')
      inp.value = src.value
      inp.addEventListener('input', () => {
        src.value = inp.value
        src.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      })
      row.appendChild(inp)
    }

    const group = document.createElement('div')
    group.className = 'wbtns'
    const mk = (b) => {
      const out = document.createElement('button')
      out.type = 'button'
      out.className = 'takecard__btn wbtn'
      const label = BTN_LABEL(b)
      out.title = b.getAttribute('title') || label
      out.innerHTML = (b.querySelector('svg') ? b.querySelector('svg').outerHTML : '') + `<span>${label}</span>`
      if (b.disabled) out.disabled = true
      if (b.classList.contains('takecard__del')) out.classList.add('wbtn--del')
      return out
    }
    /* THE SAME FIVE ON EVERY TAKE (Robert: "keep buttons fucking consistent").
       A row that is three buttons wide on one take and five on the next is a
       row you have to read every time. Send and Copy link are on every take and
       DISABLED when there is no cloud copy to send — which is the app's own
       rule for them, already stamped on the card's buttons by app-sim.js, so
       cloning carries the true state rather than a guess made here. */
    for (const b of card.querySelectorAll('.cardtools .takecard__btn')) group.appendChild(mk(b))
    for (const b of card.querySelectorAll('.takecard__actions .takecard__btn')) group.appendChild(mk(b))
    const del = card.querySelector('.cardtools .takecard__del')
    if (del) group.appendChild(mk(del))
    row.appendChild(group)

    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'watchx'
    x.title = 'Back to the list'
    x.setAttribute('aria-label', 'Back to the list')
    x.innerHTML = dic('close')
    row.appendChild(x)
    bar.appendChild(row)

    /* AND THE TAKE'S OWN FACTS UNDER ITS NAME (Robert, 2026-09-06). The card is
       behind the player and cannot be read, so the three things its last line
       says — how good, how big, when — come up here in the same order and the
       same clothes. Cloned, not moved: the card still needs them when the
       picture goes home. A row of its own, because the controls take the width
       of the first one and a fact squeezed to eighty pixels is not a fact. */
    const meta = document.createElement('div')
    meta.className = 'wmeta'
    for (const sel of ['.takecard__step', '.takecard__size', '.takecard__when']) {
      const el = card.querySelector('.takecard__top ' + sel)
      if (el) meta.appendChild(el.cloneNode(true))
    }
    if (meta.children.length) bar.appendChild(meta)

    headEl.appendChild(bar)
  }

  /* ---------- the tool bar becomes the player's, and then the editor's -------
     Robert, 2026-09-06: "in play window when open make toolbar replaced from
     above with bar for player and button edit, when edit pressed make player
     bar replaced with timeline and other shit for editing."

     Choosing inputs and pressing record are things you do BEFORE a take, and
     there is a finished one on the screen — so the control bar hands its place
     over, the same way the head does above. It comes from ABOVE because it
     belongs to the picture over it, where the head's row came from below.

     NOTHING IN IT IS DRAWN HERE. The transport and the timeline are lifted out
     of the app's own editor screen — SNAP.editor, the frozen capture the third
     tab is made of — so what you press in the player is the app's real player,
     and pressing Edit puts the app's real timeline under it. The only new thing
     is the Edit button, and it is the head's button. */
  let EDDOC = null
  const editorDoc = () => {
    if (EDDOC !== null) return EDDOC
    try {
      const src = typeof SNAP !== 'undefined' && SNAP.editor
      EDDOC = src ? new DOMParser().parseFromString(src, 'text/html') : false
    } catch (err) {
      EDDOC = false
    }
    return EDDOC
  }

  /* THE TIMELINE FILLS THE WIDTH IT IS GIVEN (Robert, 2026-09-06). The clips
     and the ruler ticks carry the pixel geometry the app laid out at capture
     time — so many pixels per second, for the width the editor screen had — and
     dropped into a wider dock they simply stop early and leave a tail. Nothing
     is hardcoded to undo that: the clips are asked how far they reach, the
     track is asked how wide it is, and every inline px inside the timeline is
     multiplied by the ratio. Ticks, clips, trims and playhead all scale
     together, so it is the same timeline at a different zoom. */
  function fitTimeline(where) {
    const tl = where.querySelector('.tl')
    const track = tl && tl.querySelector('.lane__track')
    if (!tl || !track) return
    const width = track.getBoundingClientRect().width
    /* how far the take reaches is written on the bars themselves, in the pixels
       the app laid them out with — the clip element around them is a full-width
       wrapper and says nothing */
    let reach = 0
    for (const el of tl.querySelectorAll('.lane__bar')) {
      reach = Math.max(reach, (parseFloat(el.style.left) || 0) + (parseFloat(el.style.width) || 0))
    }
    if (!(reach > 1) || !(width > 1) || Math.abs(reach - width) < 1) return
    const k = width / reach
    const px = (v) => (v && v.slice(-2) === 'px' ? (parseFloat(v) * k).toFixed(2) + 'px' : v)
    for (const el of tl.querySelectorAll('[style]')) {
      const st = el.style
      for (const prop of ['left', 'width', 'right']) if (st[prop]) st[prop] = px(st[prop])
      /* the filmstrip is painted as a background, so its size and offset are
         part of the same geometry and scale with it */
      for (const prop of ['backgroundSize', 'backgroundPosition']) {
        if (st[prop]) st[prop] = st[prop].split(' ').map(px).join(' ')
      }
    }
  }

  function watchDock(root) {
    const bar = root.querySelector('.controlbar')
    if (!bar) return null
    let dock = bar.querySelector('.watchdock')
    if (dock) return dock
    dock = document.createElement('div')
    dock.className = 'watchdock'
    const play = document.createElement('div')
    play.className = 'wdock__play'
    const ed = editorDoc()
    const t = ed && ed.querySelector('.transport')
    if (t) {
      const c = t.cloneNode(true)
      /* the editor's back arrow goes to the takes list, and we are ON the takes
         list with a picture over it — the cross in the head is the way out, so
         the arrow would be a second one that means something else */
      const back = c.querySelector('.transport__back')
      if (back) back.remove()
      play.appendChild(c)
    }
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'wbtn wedit'
    edit.title = 'Edit this take'
    edit.setAttribute('aria-pressed', 'false')
    edit.innerHTML = ic('scissors') + '<span>Edit</span>'
    edit.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      watchEdit(root)
    })
    play.appendChild(edit)
    dock.appendChild(play)
    bar.appendChild(dock)
    bar.classList.add('is-watch')
    return dock
  }

  /* THE PLAY BAR STAYS AND THE EDITOR UNFOLDS UNDER IT (Robert, 2026-09-06:
     "play bar must stay too when edit bar comes", "edit bar must come straight
     from under play window, not diagonaly"). The transport is not rebuilt and
     not moved — the same row, untouched — and the tools and the timeline open
     downward out from under it, by their own height, so the only direction
     anything travels is down. A slide would have been diagonal: the bar narrows
     to the picture's new width at the same time, and a box that moves down
     while its edges move in reads as a corner, not a drawer.

     AND THE MOVE IS REHEARSED FIRST. The bar grows, the frame re-centres and
     the room over it changes; asking for that room mid-transition reads a
     number the layout is only passing through. So the finished state is set up
     with the clock stopped, measured, put back, and only then started for real
     — the picture, the bar, the width and the drawer all on one curve. */
  function watchEdit(root) {
    const bar = root.querySelector('.controlbar')
    const dock = watchDock(root)
    const ed = editorDoc()
    if (!bar || !dock) return
    /* THE BUTTON IS A SWITCH (Robert, 2026-09-06). Pressed again it shuts the
       drawer the same way closing the player does — fold, and the picture takes
       back the room it lent. The block is thrown away rather than parked at
       zero: the timeline it holds has been scaled to a width, and scaling the
       same nodes again would compound it. */
    const open = dock.querySelector('.wdock__edit')
    if (open) {
      open.style.height = '0px'
      bar.classList.remove('is-edit')
      bar.style.setProperty('--dock-h', '0px')
      const btn = dock.querySelector('.wedit')
      if (btn) btn.setAttribute('aria-pressed', 'false')
      if (WATCH.box && WATCH.playAt) {
        WATCH.at = WATCH.playAt
        boxAt(WATCH.box, ...WATCH.playAt)
        root.style.setProperty('--take-w', WATCH.playW)
      }
      setTimeout(() => open.remove(), 440)
      return
    }

    const block = document.createElement('div')
    block.className = 'wdock__edit'
    for (const sel of ['.tools', '.tl']) {
      const el = ed && ed.querySelector(sel)
      if (el) block.appendChild(el.cloneNode(true))
    }
    if (!block.children.length) return
    dock.appendChild(block)

    const cap = root.querySelector('.capture')
    const capH = cap ? cap.getBoundingClientRect().height : 660
    const wasW = root.style.getPropertyValue('--take-w')

    root.classList.add('dz-nofx')
    bar.classList.add('is-edit')
    bar.style.setProperty('--dock-h', '0px')
    block.style.height = 'auto'
    void bar.offsetHeight
    /* SUMMED, NOT scrollHeight: the dock centres what it holds, and a centred
       flex box overflows in BOTH directions while scrollHeight counts only the
       half that hangs below — it read 152 for content standing 223 tall. */
    const kids = [...dock.children]
    const GAP = 10
    const natural =
      24 + GAP * Math.max(0, kids.length - 1) + kids.reduce((n, c) => n + c.getBoundingClientRect().height, 0)
    const want = Math.round(Math.min(natural, capH * 0.52))
    const blockH = Math.round(block.getBoundingClientRect().height)
    bar.style.setProperty('--dock-h', want + 'px')
    void bar.offsetHeight
    const target = playerBox(root, WATCH.ratio)
    const willW = target ? Math.max(420, Math.round(target[2])) + 'px' : wasW
    /* the timeline is stretched IN THE FRAME IT WILL LAND IN — fitted to the
       width it has now it would overhang by the difference */
    root.style.setProperty('--take-w', willW)
    void bar.offsetHeight
    fitTimeline(block)
    root.style.setProperty('--take-w', wasW)
    bar.classList.remove('is-edit')
    bar.style.setProperty('--dock-h', '0px')
    block.style.height = '0px'
    void bar.offsetHeight
    root.classList.remove('dz-nofx')
    /* the rehearsal left the clock stopped: this reflow commits the starting
       frame with it running again, or the whole move happens inside one task
       and is never drawn */
    void bar.offsetHeight

    bar.classList.add('is-edit')
    bar.style.setProperty('--dock-h', want + 'px')
    block.style.height = blockH + 'px'
    const btn = dock.querySelector('.wedit')
    if (btn) btn.setAttribute('aria-pressed', 'true')
    if (WATCH.box && target) {
      WATCH.at = target
      boxAt(WATCH.box, ...target)
      root.style.setProperty('--take-w', willW)
    }
  }

  /* THE EDITOR FOLDS AWAY FIRST, THEN THE PICTURE GOES HOME (Robert,
     2026-09-06: "if it open and play window closes first it goes under play
     window and than windows goes back to preview in card"). Two moves, in that
     order, because they are two facts: you are done editing, and you are done
     watching. The picture does not move while the drawer closes — it is
     positioned in the frame, not in the bar — so the second move starts from
     exactly where the first one left everything. */
  function watchClose() {
    const { root, card, box } = WATCH
    if (!card || !box) return
    WATCH.card = null
    const cbar = root.querySelector('.controlbar')
    const block = cbar && cbar.querySelector('.wdock__edit')
    if (block) {
      block.style.height = '0px'
      cbar.classList.remove('is-edit')
      cbar.style.setProperty('--dock-h', '0px')
    }
    clearTimeout(WATCH.timer)
    WATCH.timer = setTimeout(() => watchGoHome(root, card, box), block ? 300 : 0)
  }

  function watchGoHome(root, card, box) {
    const takes = root.querySelector('.takes')
    if (takes) takes.classList.remove('is-watch')
    root.style.removeProperty('--take-w')
    const cbar = root.querySelector('.controlbar')
    if (cbar) {
      cbar.classList.remove('is-watch', 'is-edit')
      cbar.style.removeProperty('--dock-h')
    }
    box.classList.add('is-closing')
    /* home is the slot it came out of, remembered from the way in. A card the
       list no longer holds — a tab changed under it — has no slot to go home
       to, and the picture simply leaves. */
    const thumb = card.querySelector('.takecard__thumb')
    const gone = !thumb || thumb.getBoundingClientRect().width < 2
    if (gone || !WATCH.from) box.classList.add('is-gone')
    else boxAt(box, ...WATCH.from)
    WATCH.timer = setTimeout(() => {
      box.remove()
      card.classList.remove('is-watching')
      const bar = root.querySelector('.watchbar')
      if (bar) bar.remove()
      const dock = root.querySelector('.watchdock')
      if (dock) dock.remove()
      WATCH.box = null
      WATCH.from = null
      WATCH.at = null
      WATCH.playAt = null
    }, 440)
  }

  function watch(root) {
    const takes = root.querySelector('.takes')
    if (!takes || takes.dataset.dzWatch) return
    takes.dataset.dzWatch = '1'
    takes.addEventListener('click', (e) => {
      const thumb = e.target.closest('.takecard__thumb')
      if (!thumb || takes.classList.contains('is-picking')) return
      /* app-sim.js listens for this same press on the app root and takes it to
         the editor screen — the flow it wires for BOTH tabs. The proposal
         answers the press here, deeper in the tree, and stops it going up. */
      e.preventDefault()
      e.stopPropagation()
      watchOpen(root, thumb.closest('.takecard'))
    })
    if (window.__dzWatch) return
    window.__dzWatch = true
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') watchClose()
    })
    /* A PRESS ANYWHERE ELSE IS A PRESS ON THE APP BEHIND THE VIDEO — a tab, the
       search, the record button. The video gets out of the way and the press
       does what it always did; only the player itself is not that. */
    document.addEventListener(
      'click',
      (e) => {
        if (!WATCH.card) return
        if (e.target.closest('.watchx')) {
          e.preventDefault()
          e.stopPropagation()
          watchClose()
          return
        }
        if (e.target.closest('.watchbox, .watchbar, .watchdock')) return
        watchClose()
      },
      true,
    )
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
          <label class="find">${dic('search')}<input type="search" placeholder="Search" /></label>
          <span class="normx">
            <button class="tool2" data-t="filter" aria-pressed="false" title="Filter">${dic('filter')}</button>
            <button class="tool2" data-t="sort" aria-pressed="false" title="Sort">${dic('sort')}</button>
          </span>
        </div>
        <div class="rightgrp">
          <div class="where" role="tablist">
            <button role="tab" aria-selected="${WHERE === 'device'}" data-where="device">${dic('device')}Device</button>
            <button role="tab" aria-selected="${WHERE === 'cloud'}" data-where="cloud">${dic('cloud')}Cloud</button>
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
          <span class="selx"><span class="selx__in">
            <button class="tool2 tool2--txt" data-p="all">All</button>
            <button class="tool2 tool2--txt" data-p="clear">Clear</button>
          </span></span>
          <!-- ONE SLOT, TWO ANSWERS. How many files there are, and — the moment
               anything is picked — how many of them. The second comes up from
               under the first and the first leaves through the top, so it reads
               as the same fact being restated rather than a new control. -->
          <span class="swapv totalx">
            <span class="swapv__a"><b class="total__n">0</b><span class="total__w">files</span></span>
            <span class="swapv__b"><b class="picked__n">0</b><i class="picked__sl">/</i><span class="picked__tot">0</span><span class="picked__w">selected</span></span>
          </span>
        </div>
        <!-- AND THE OTHER END OF THE ROW SWAPS THE SAME WAY. How much room is
             left is what that corner says when nothing is picked; what you can
             do with a selection is what it says when something is. Both are the
             answer to "and now?", so they are one slot, not two — and the
             storage bar leaves through the top exactly as the file count does,
             so the row moves as one thing. The buttons are the card's own
             glyphs, cloned (cards() runs before head()), so there is one place
             the drawing is chosen. -->
        <div class="room swapv">
          <span class="swapv__a">${
            pct === null
              ? ''
              : `<div class="room__bar"><div class="room__fill${pct > 85 ? ' is-tight' : ''}" style="width:${pct.toFixed(1)}%"></div></div>
                 <div class="room__note"><b>${bytes(room.quota - room.usage)}</b> free of ${bytes(room.quota)}</div>`
          }</span>
          <span class="swapv__b picked">
            <button data-p="save">${glyphOf(root, '.cardtools [title="Download"]', 'download')}<span>Download</span></button>
            <button data-p="del" class="is-danger">${glyphOf(root, '.cardtools .takecard__del', 'trash')}<span>Delete</span></button>
          </span>
        </div>
      </div>`

    /* the drawer's cap, measured rather than guessed — see the note on .selx in
       the stylesheet. scrollWidth reports the content width even while the
       element is clamped to nothing, which is the whole reason this works. */
    const selx = headEl.querySelector('.selx')
    const selxIn = selx && selx.querySelector('.selx__in')
    if (selxIn) selx.style.setProperty('--selx-w', selxIn.scrollWidth + 'px')

    total(takes)
    wireHead(root, takes, headEl)
    /* run the filter once on the way in, on whichever tab was last chosen, so
       the list opens holding the right library rather than everything and a
       correction later */
    takes.classList.toggle('is-cloud', WHERE === 'cloud')
    applyFilter(takes)
  }

  /* ANYTHING THAT CHANGES HOW MANY ROWS ARE SHOWING CHANGES THE HEIGHT OF THE
     LIST, and the list is what holds the control bar and the record button
     where they are. Hiding rows in one frame threw all of that up the screen.
     Measure, apply, measure, then let CSS carry it between the two — and put
     the height back to auto at the end so a later change starts from the truth
     rather than from a number this function pinned on it. */
  /* AND WHEN IT IS THE TAB THAT CHANGED, THE NEW FEED COMES IN FROM ITS OWN
     SIDE: Cloud from the right, Device from the left, which is where each tab
     sits in the pair. `dir` is 0 for a search or a filter — the same rows are
     still there, so nothing should travel. Order matters and it is fiddly: swap
     the content, put it a FULL COLUMN off to that side with NO transition, pin
     the old height, one reflow, then release both at once so the height and the
     slide are one movement rather than two of the same length that start apart. */
  const HTIMER = new WeakMap()
  /* THE FEED THAT LEAVES HAS TO LEAVE. Only the arriving one was animated, so
     the old list blinked out under it — half a transition reads worse than
     none. The two sets are the same elements with different rows hidden, so
     they cannot both be in the list at once: the outgoing one is CLONED first,
     hung over the list with no effect on layout, and slid the other way. Both
     halves ride the same curve, which is the whole trick — with one curve the
     gap between them stays exactly one column at every instant and the pair
     moves as one strip rather than two things passing each other. */
  function ghostOf(takes, list) {
    const g = document.createElement('div')
    g.className = 'listghost'
    g.style.top = list.offsetTop + 'px'
    g.style.height = list.getBoundingClientRect().height + 'px'
    const copy = list.cloneNode(true)
    copy.style.height = ''
    g.appendChild(copy)
    /* cloneNode copies the value ATTRIBUTE, not what is typed in the box, so a
       take you have named would go blank for the length of the slide */
    const src = [...list.querySelectorAll('input')]
    ;[...copy.querySelectorAll('input')].forEach((el, i) => { el.value = src[i] ? src[i].value : '' })
    const note = takes.querySelector('.cloud-empty')
    if (note && !note.hidden) g.appendChild(note.cloneNode(true))
    return g
  }
  function swapList(takes, dir, mutate) {
    const list = takes && takes.querySelector('.takes__list')
    if (!list) return mutate()
    const from = list.getBoundingClientRect().height
    const ghost = dir ? ghostOf(takes, list) : null
    mutate()
    list.style.height = ''
    const to = list.getBoundingClientRect().height
    const moves = Math.abs(to - from) >= 1
    if (!dir && !moves) return
    if (dir) {
      takes.style.setProperty('--slide-from', dir > 0 ? '100%' : '-100%')
      takes.classList.add('is-from', 'is-clip')
      takes.appendChild(ghost)
      void list.offsetHeight
    }
    if (moves) list.style.height = from + 'px'
    void list.offsetHeight // the reflow that makes the next lines a transition
    takes.classList.remove('is-from')
    if (moves) list.style.height = to + 'px'
    if (ghost) ghost.classList.add('is-gone')
    clearTimeout(HTIMER.get(list))
    HTIMER.set(list, setTimeout(() => {
      list.style.height = ''
      takes.classList.remove('is-clip')
      for (const old of takes.querySelectorAll('.listghost')) old.remove()
    }, 460))
  }
  const animateHeight = (list, mutate) => swapList(list && list.closest('.takes'), 0, mutate)

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
      const list = takes.querySelector('.takes__list')
      animateHeight(list, () => applyNow(list))
    }
    FILTERS.set(takes, () => applyNow(takes.querySelector('.takes__list')))
    const applyNow = (list) => {
      const q = (input.value || '').trim().toLowerCase()
      const cards = [...takes.querySelectorAll('.takecard')]
      /* WHERE IT IS KEPT IS THE FIRST FILTER and it is not negotiable — the
         search and the kind menu narrow within the tab you are on, never across
         it. Everything downstream counts what this leaves. */
      const onCloud = takes.classList.contains('is-cloud')
      for (const c of cards) c.dataset.here = (c.dataset.cloud === '1') === onCloud ? '1' : ''
      for (const c of cards) {
        /* a name you typed lives in a value, not in the text, so the search has
           to be told about it — and the one the app would give it too */
        const nm = c.querySelector('.takename')
        const hay = ((c.textContent || '') + ' ' + (nm ? nm.value + ' ' + nm.placeholder : '')).toLowerCase()
        const kinds = [...c.querySelectorAll('.kind')].map((k) => k.textContent.trim().toLowerCase())
        const okQ = !q || hay.includes(q)
        const okF = state.filter === 'all' || kinds.some((k) => k === state.filter)
        c.hidden = !(c.dataset.here === '1' && okQ && okF)
      }
      emptyNote(takes, cards.filter((c) => !c.hidden).length)
      total(takes)
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
        /* TWO PLACES, NOT ONE PLACE WITH A FLAG (Robert, 2026-09-06: "why the
           fuck cloud records in device tab"). A take is kept HERE or it is kept
           UP THERE, and each tab is that place's whole library — a cloud take
           has no business under Device, which is what a tab called Device is
           for. The device count and the cloud count are separate libraries now,
           and both tabs can be empty on their own terms. */
        const onCloud = w.dataset.where === 'cloud'
        WHERE = w.dataset.where
        takes.classList.toggle('is-cloud', onCloud)
        // Cloud is the right-hand tab, so its feed arrives from the right
        swapList(takes, onCloud ? 1 : -1, () => applyNow(takes.querySelector('.takes__list')))
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
  /* head() wires the filter and then needs to run it; the closure that knows
     about the search box and the kind menu lives inside wireHead, so it leaves
     a handle here rather than either of them reaching into the other. */
  /* WHICH TAB YOU ARE ON SURVIVES A REFRESH. Every panel press rebuilds #app
     from the frozen snapshot, so the head is built fresh each time and used to
     come back on Device — which meant adding a take to the cloud threw you off
     the tab you were watching it appear on, and it looked like nothing had
     happened. It lives out here because the DOM that held it is gone by then. */
  let WHERE = 'device'

  const FILTERS = new WeakMap()
  const applyFilter = (takes) => { const f = FILTERS.get(takes); if (f) f() }

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
    /* "2/14" — a selection is only ever a fraction of what is there, and the
       slot it replaces was already showing the denominator */
    if (el) el.textContent = String(n)
    const tot = takes.querySelector('.picked__tot')
    if (tot) tot.textContent = String(inTab(takes).length)
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
    /* the tab you are on IS the library, so this counts that one — "1 of 3
       files" on Cloud while Device holds two others was two libraries being
       added together and neither of them being reported */
    const onCloud = takes.classList.contains('is-cloud')
    const mine = [...takes.querySelectorAll('.takecard')].filter((c) => (c.dataset.cloud === '1') === onCloud)
    const all = mine.length
    const shown = mine.filter((c) => !c.hidden).length
    n.textContent = shown === all ? String(all) : `${shown} of ${all}`
    w.textContent = all === 1 && shown === all ? 'file' : 'files'
    const tot = takes.querySelector('.picked__tot')
    if (tot) tot.textContent = String(all)
  }
  /* and the same denominator for a selection: you can only ever pick out of the
     library you are looking at */
  const inTab = (takes) => {
    const onCloud = takes.classList.contains('is-cloud')
    return [...takes.querySelectorAll('.takecard')].filter((c) => (c.dataset.cloud === '1') === onCloud)
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

  /* ---------- naming a file -----------------------------------------------
     Click away to save, which is the only rule the field has. Enter is the same
     thing with the keyboard, Escape puts back what was there, and emptying it
     hands the name back to the app — the placeholder returns and the download
     goes out under it again. Delegated on the list, so a take added later gets
     the behaviour without being wired for it. */
  function naming(root) {
    const takes = root.querySelector('.takes')
    if (!takes || takes.dataset.dzName) return
    takes.dataset.dzName = '1'

    const commit = (inp) => {
      const card = inp.closest('.takecard')
      if (!card) return
      const given = inp.value.trim()
      inp.value = given
      if (given) card.dataset.rename = given
      else delete card.dataset.rename
      /* the promise the field makes has to be visible somewhere, and the place
         it is kept is the button that would honour it */
      const stem = given || card.dataset.autoName || ''
      const name = stem ? stem + (card.dataset.ext || '.mp4') : ''
      const dl = card.querySelector('.cardtools [title^="Download"], .cardtools [data-dl]')
      if (dl) {
        /* keep what the button said before this field ever touched it, so
           emptying the name puts the button back rather than leaving it
           promising a name that is no longer anywhere on the card */
        if (!dl.dataset.dlBase) dl.dataset.dlBase = dl.title || 'Download'
        dl.dataset.dl = '1'
        dl.title = name ? `Download — saves as ${name}` : dl.dataset.dlBase
        dl.setAttribute('aria-label', name ? `Download ${name}` : dl.dataset.dlBase)
      }
    }
    takes.addEventListener('focusin', (e) => {
      const inp = e.target.closest('.takename')
      if (inp) inp.dataset.was = inp.value
    })
    takes.addEventListener('focusout', (e) => {
      const inp = e.target.closest('.takename')
      if (inp) commit(inp)
    })
    takes.addEventListener('keydown', (e) => {
      const inp = e.target.closest('.takename')
      if (!inp) return
      if (e.key === 'Enter') { e.preventDefault(); inp.blur() }
      else if (e.key === 'Escape') { inp.value = inp.dataset.was || ''; inp.blur() }
    })
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

  /* ONE NOTE, EITHER LIBRARY, and it names the reason that one is empty. Both
     tabs can be empty on their own now: everything sent up leaves Device with
     nothing to show, and an account with nothing sent leaves Cloud the same. */
  function emptyNote(takes, shown) {
    const onCloud = takes.classList.contains('is-cloud')
    let el = takes.querySelector('.cloud-empty')
    if (!el) {
      el = document.createElement('div')
      el.className = 'cloud-empty room__note'
      takes.querySelector('.takes__list').after(el)
    }
    el.textContent = onCloud
      ? (window.PROTO_SIM || {}).account === 'in'
        ? 'Nothing kept in the cloud yet — Send a take to put it there.'
        : 'Sign in to keep takes in the cloud.'
      : 'Nothing kept on this computer.'
    el.hidden = shown > 0
  }

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
    const takes = root.querySelector('.takes')
    if (takes && takes.querySelector('.cloud-empty')) {
      emptyNote(takes, [...takes.querySelectorAll('.takecard')].filter((c) => !c.hidden).length)
    }
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
    watch(root)
    motion(root)
    head(root)
    account(root)
    naming(root)
    picking(root)
    rail(root)
  }
})()
