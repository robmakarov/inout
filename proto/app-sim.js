/* ==========================================================================
   APP PROTO — THE TESTING LAYER. Inlined into BOTH proto/app.html and
   proto/ships.html, because the controls have to work on the control too: a
   proposal you can drive against a shipping tab you cannot is not an A/B.

   It is NOT the design proposal (that is app-design.css / app-design.js, and it
   only goes into app.html). Everything here either drives a control the app
   already has, or simulates a state the app can really be in — the classes it
   sets are the app's own (chip--on, chip--unavailable, qs__label--on), so a
   simulated state renders through whichever design is loaded.

   Re-run after every state switch, and after every panel change. Idempotent.
   ========================================================================== */
;(function () {
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)]
  const KINDS = ['screen', 'camera', 'mic', 'tab audio']
  const nameOf = (b) => (b.getAttribute('title') || b.textContent || '').trim().toLowerCase()

  /* ---------- the inputs, in every state the app can put them in ---------- */
  function inputs(root, sim) {
    for (const chip of $$('.chip', root)) {
      const kind = nameOf(chip)
      const st = (sim.inputs && sim.inputs[kind]) || 'ok'
      const on = sim.on ? sim.on[kind] !== false : true
      chip.classList.remove('chip--on', 'chip--unavailable', 'chip--muted', 'chip--pending')
      chip.disabled = false
      if (st === 'unavailable' || st === 'denied') {
        chip.classList.add('chip--unavailable')
        chip.setAttribute('aria-pressed', 'false')
        chip.title = st === 'denied' ? 'Access was refused — allow it in the browser' : 'Not available on this machine'
      } else {
        chip.title = kind.replace(/\b\w/g, (c) => c.toUpperCase())
        chip.classList.toggle('chip--on', on)
        chip.setAttribute('aria-pressed', String(on))
      }
      // the app slashes the glyph of anything that is off or unavailable
      const slash = st !== 'ok' || !on
      const svg = chip.querySelector('svg')
      if (svg) svg.style.opacity = slash ? '0.55' : ''
    }
    // the hint the app shows when there is nothing to record
    const anyOn = KINDS.some((k) => (sim.inputs?.[k] || 'ok') === 'ok' && sim.on?.[k] !== false)
    const hint = root.querySelector('.controlbar__hint')
    if (hint) hint.hidden = anyOn
    const rec = root.querySelector('.recbtn')
    if (rec && !root.querySelector('.recbtn__inner--stop')) rec.disabled = !anyOn
  }

  /* ---------- the quality rail actually moves ----------------------------- */
  function rail(root) {
    for (const qs of $$('.qs', root)) {
      if (qs.dataset.sim) continue
      qs.dataset.sim = '1'
      qs.addEventListener('click', (e) => {
        const label = e.target.closest('.qs__label')
        if (!label || label.className.includes('qs__label--locked') || label.disabled) return
        const labels = $$('.qs__label', qs)
        for (const l of labels) l.classList.toggle('qs__label--on', l === label)
        const value = qs.querySelector('.qs__value')
        if (value) value.textContent = (label.querySelector('.qs__label-text') || label).textContent.trim()
        place(qs)
        if (window.applyDesign) window.applyDesign(document.getElementById('app'))
      })
      place(qs)
    }
  }
  /* Where the thumb sits. The shipping rail puts it at the stop's own point on
     a line; the proposal makes it a segment. app-design.js does the segment
     case, so this only has to be right for the untouched one. */
  function place(qs) {
    if (window.PROTO_DESIGN) return
    const labels = $$('.qs__label', qs)
    const thumb = qs.querySelector('.qs__thumb')
    if (!labels.length || !thumb) return
    const i = Math.max(0, labels.findIndex((l) => l.className.includes('qs__label--on')))
    thumb.style.left = ((i / Math.max(1, labels.length - 1)) * 100).toFixed(3) + '%'
  }

  /* ---------- what the app is recording: itself ---------------------------
     Robert: "instead of record show ui screeshot itself like its mirrored". The
     capture's synthetic source is a painted test pattern, which says nothing
     about the product; a picture of THIS proto in the preview says the obvious
     true thing — you are recording your screen, and your screen has the app on
     it. window.PROTO_MIRROR is a still of the proto's own frame, taken by
     `proto-app.mjs --mirror` after the page is built. It does not animate, and
     does not need to: it is a still of a screen, not a video of one. */
  function mirror(root) {
    const src = window.PROTO_MIRROR
    if (!src) return
    for (const im of $$('.stage__screen, .takecard__thumb img, .stage__composite', root)) {
      if (im.tagName !== 'IMG' || im.dataset.mirrored) continue
      im.dataset.mirrored = '1'
      im.src = src
    }
  }

  /* ---------- the flow: this proto behaves like the app -------------------
     Every screen here is a real capture of the real app, so wiring the presses
     between them costs nothing and buys the only thing stills cannot show —
     whether the path from a record press to a saved file reads right. Nothing
     is faked: each press lands on the screen the app would actually be on. */
  function flow(root) {
    if (root.dataset.simFlow) return
    root.dataset.simFlow = '1'
    const go = (id) => window.protoGo && window.protoGo(id)
    root.addEventListener('click', (e) => {
      const rec = e.target.closest('.recbtn')
      if (rec && !rec.disabled) {
        // the same button is start and stop, exactly as the app has it
        go(root.querySelector('.recbtn__inner--stop') ? 'editor' : 'recording')
        return
      }
      // a take's picture opens it, which is what the app does with that press
      if (e.target.closest('.takecard__thumb')) { go('editor'); return }
      if (e.target.closest('.transport__back')) { go('main'); return }
      const btn = e.target.closest('button')
      if (!btn || btn.disabled) return
      const label = (btn.textContent || '').trim().toLowerCase()
      if (label.startsWith('export') || label === 'for ai') {
        go('exporting')
        // the render is real in the app and takes time; here it is a beat, so
        // the dock's two states can both be seen from one press
        setTimeout(() => go('saved'), 1400)
        return
      }
      if (btn.classList.contains('xstrip__x')) go('editor')
    })
  }

  /* ---------- every other control the app already draws ------------------- */
  function controls(root) {
    if (root.dataset.simWired) return
    root.dataset.simWired = '1'
    root.addEventListener('click', (e) => {
      // an input chip: on and off, unless the state says it cannot be
      const chip = e.target.closest('.chip')
      if (chip) {
        const k = nameOf(chip)
        const sim = window.PROTO_SIM
        if ((sim.inputs?.[k] || 'ok') !== 'ok') return
        sim.on = sim.on || {}
        sim.on[k] = sim.on[k] === false
        window.protoRefresh()
        return
      }
      // one-of-a-group controls: speeds, frame swatches, the lane eyes
      const speed = e.target.closest('.speedbar button, .speed button')
      if (speed) {
        for (const b of speed.parentElement.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === speed))
        return
      }
      const sw = e.target.closest('.frame-bar__swatch')
      if (sw) {
        for (const b of sw.parentElement.querySelectorAll('.frame-bar__swatch')) {
          b.setAttribute('aria-checked', String(b === sw))
          b.classList.toggle('frame-bar__swatch--on', b === sw)
        }
        return
      }
      const eye = e.target.closest('.lane__eye')
      if (eye) {
        const lane = eye.closest('.lane') || eye.parentElement
        const off = lane.classList.toggle('lane--hidden')
        eye.style.opacity = off ? '0.35' : ''
        return
      }
      const tool = e.target.closest('.tools button')
      if (tool && !tool.disabled) {
        tool.setAttribute('aria-pressed', String(tool.getAttribute('aria-pressed') !== 'true'))
        return
      }
      // the transport's play button, which is a state and not a press
      const play = e.target.closest('.transport__play')
      if (play) {
        const playing = play.getAttribute('aria-label') === 'Pause'
        play.setAttribute('aria-label', playing ? 'Play' : 'Pause')
        play.classList.toggle('is-playing', !playing)
      }
    })
  }

  /* ---------- takes: add one, take one away ------------------------------ */
  function takes(root, sim) {
    const list = root.querySelector('.takes__list')
    if (!list) return
    const cards = $$('.takecard', list)
    if (!cards.length) return
    const base = Number(list.dataset.base || cards.length)
    list.dataset.base = String(base)
    /* null means "as captured"; a number is exact, and ZERO IS A REAL STATE —
       the app renders no takes block at all when there is nothing kept, which
       is what a first run and a cleared library both look like. */
    const want = sim.takes == null ? base : Math.max(0, sim.takes)
    const takesEl = root.querySelector('.takes')
    if (takesEl) takesEl.hidden = want === 0
    if (want === 0) return

    while ($$('.takecard', list).length > want) list.lastElementChild.remove()
    while ($$('.takecard', list).length < want) {
      const all = $$('.takecard', list)
      const clone = all[all.length - 1].cloneNode(true)
      /* A CLONE, RESTAMPED — and it says so in the DOM rather than pretending
         to be a take that was made. The proto is here to test how the list
         behaves at length; inventing plausible file sizes would make the
         storage bar above it a lie. */
      clone.dataset.simClone = '1'
      /* WHAT THE ADDED TAKE IS MADE OF, as the panel asked for it: which inputs
         it used, and whether a copy of it is kept in the cloud. sim.added holds
         one of these per take beyond the base, in the order they were added.
         The kinds go in as the app's own plain text — applySim runs before
         applyDesign on a freshly injected screen, so the card is still raw here
         and the design layer turns this line into the little chips itself. */
      const spec = (sim.added || [])[$$('.takecard', list).length - base]
      if (spec) {
        const kindsEl = clone.querySelector('.takecard__kinds')
        if (kindsEl && spec.kinds && spec.kinds.length) kindsEl.textContent = spec.kinds.join(' · ')
        clone.dataset.simCloud = spec.cloud ? '1' : '0'
      }
      const n = all.length + 1
      const when = clone.querySelector('.takecard__when')
      if (when) {
        const src = when.dataset.whenFull || when.textContent
        when.dataset.whenFull = src.replace(/(\d\d):(\d\d)$/, (m, h, mm) => {
          const t = (Number(h) * 60 + Number(mm) - n * 7 + 1440) % 1440
          return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0')
        })
        when.textContent = when.dataset.whenFull
      }
      list.appendChild(clone)
    }
    const head = root.querySelector('.takes__head')
    const count = head && head.firstChild && !head.dataset.dz ? head.querySelector('span, div') : null
    if (count && /takes? kept/i.test(count.textContent || '')) {
      count.textContent = `${want} take${want === 1 ? '' : 's'} kept on this computer`
    }
  }

  /* ---------- what the editor is in the middle of ------------------------ */
  function editor(root, sim) {
    const missing = sim.lost && sim.lost !== 'none' ? sim.lost : null
    let band = root.querySelector('.editor__missing[data-sim]')
    const editorEl = root.querySelector('.editor')
    if (!editorEl) return
    if (missing) {
      if (!band) {
        band = document.createElement('div')
        band.className = 'editor__missing'
        band.setAttribute('role', 'alert')
        band.dataset.sim = '1'
        editorEl.insertBefore(band, editorEl.firstChild)
      }
      const label = missing.replace(/\b\w/g, (c) => c.toUpperCase())
      band.textContent =
        sim.lost === 'stalled'
          ? `${label} froze for part of this take — those seconds are a still image.`
          : `Missing from this take: ${label} — the device never connected.`
      band.hidden = false
    } else if (band) band.remove()
  }

  /* ---------- which takes have a copy in the cloud ------------------------
     A take is made on this machine. An ACCOUNT is what lets a copy of it live
     in the cloud as well, and only that copy can be sent or linked — so this is
     a per-take state, it is impossible without an account, and it belongs here
     rather than in the proposal because the app can really be in it. The
     proposal reads data-cloud to decide what a card offers; the shipping tab
     ignores it and keeps drawing every button, which is the A/B. */
  function cloud(root, sim) {
    const inAcct = sim.account === 'in'
    const how = inAcct ? sim.cloud || 'none' : 'none'
    $$('.takecard', root).forEach((c, i) => {
      /* A TAKE ADDED FROM THE PANEL SAYS FOR ITSELF WHERE IT IS KEPT, and that
         beats the blanket rule — otherwise pressing "+ take" with cloud chosen
         put it on the device anyway, depending on where it landed in the order,
         and the Cloud tab never showed it. Still impossible without an account:
         there is nowhere to keep it. */
      const own = c.dataset.simCloud
      const up = inAcct && (own === '1' || (own !== '0' && (how === 'all' || (how === 'some' && i % 2 === 0))))
      if (up) c.dataset.cloud = '1'
      else delete c.dataset.cloud
    })
  }

  /* ---------- signed in, signed out -------------------------------------- */
  /* The cloud buttons are the part of this that exists in the SHIPPING markup,
     so it lives here rather than in the proposal: both tabs answer the account
     switch. Send and Copy link are the two things an account actually buys —
     and what they act on is the cloud copy, so a take without one cannot use
     them even when you are signed in. */
  function account(root, sim) {
    for (const b of $$('.takecard__btn, .xstrip__btn', root)) {
      const t = (b.textContent || '').trim().toLowerCase()
      if (t !== 'send' && t !== 'copy link' && t !== 'make a link') continue
      const card = b.closest('.takecard')
      b.disabled = card ? card.dataset.cloud !== '1' : sim.account !== 'in'
    }
  }

  window.applySim = function (root, sim) {
    if (!root || !sim) return
    mirror(root)
    flow(root)
    inputs(root, sim)
    /* takes() first: it clones and removes cards, and the two after it stamp
       every card that is then in the list. They used to run before it, so a
       cloned take answered no switch at all. */
    takes(root, sim)
    cloud(root, sim)
    account(root, sim)
    editor(root, sim)
    rail(root)
    controls(root)
  }
})()
