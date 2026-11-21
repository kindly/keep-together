import './give.css'
import { leaveFor, loadPage, newId, routeFrom, sendDonation } from './api'
import type { Field, RetryWhy } from './api'
import { formatPence, fromWire, giftAidOn, parsePounds, toWire } from './money'
import { wordingFor } from './wording'
import type { Wording } from './wording'
import type { GiveDonation } from '#/lib/data/rust-types/GiveDonation'
import type { GivePage } from '#/lib/data/rust-types/GivePage'

/**
 * The donor's page (`/give/{slug}`, plan stripe.sv step S4): no React and
 * none of the app's bundle. It shows the group's amounts, takes a name,
 * an email and, if the donor ticks it, a Gift Aid declaration with their
 * home address, sends them once, and hands the donor to Stripe's payment
 * page for the card. `/give/{slug}/thanks` is where Stripe sends them
 * back: it writes nothing and proves nothing; the gift is recorded when
 * Stripe tells the server it was paid.
 *
 * Nothing the donor types is kept in the browser: not in storage, not in
 * the address.
 */

const root = document.getElementById('give')!
const route = routeFrom(location.pathname)

type Child = Node | string | null | false

function h<TTag extends keyof HTMLElementTagNameMap>(
  tag: TTag,
  attrs: Record<string, string | boolean> = {},
  ...children: Array<Child>
): HTMLElementTagNameMap[TTag] {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false) continue
    el.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children) if (child) el.append(child)
  return el
}

function show(screen: string, ...children: Array<Child>) {
  const section = h('section', { 'data-screen': screen }, ...children)
  root.replaceChildren(section)
  return section
}

const RETRY: Record<RetryWhy, string> = {
  offline: 'We couldn’t reach the server. Check your connection and try again.',
  limited:
    'Too many tries from this connection. Wait a minute, then try again.',
  stripe:
    'The card payment service isn’t answering. Nothing has been taken. Try again in a moment.',
  server:
    'Something went wrong on our side. Nothing has been taken. Try again in a moment.',
}

function absent() {
  document.title = 'Not taking donations'
  show(
    'absent',
    h('h1', {}, 'This page isn’t taking donations'),
    h(
      'p',
      {},
      'The link may be mistyped, or the group hasn’t opened its donation page yet. Ask them for their current link.',
    ),
  )
}

function unreachable(why: RetryWhy) {
  const again = h('button', { type: 'button', class: 'primary' }, 'Try again')
  again.addEventListener('click', () => void start())
  show(
    'retry',
    h('h1', {}, 'We couldn’t load this page'),
    h('p', {}, RETRY[why]),
    again,
  )
}

function thanks(page: GivePage, slug: string) {
  document.title = `Thank you · ${page.name}`
  show(
    'thanks',
    h('h1', {}, 'Thank you'),
    h('p', {}, `Thank you for giving to ${page.name}.`),
    h(
      'p',
      { class: 'muted' },
      'Stripe emails your receipt once the card payment has gone through. If you closed its page before paying, nothing was taken.',
    ),
    h('p', {}, h('a', { href: `/give/${slug}` }, 'Give again')),
  )
}

interface FieldRow {
  row: HTMLElement
  input: HTMLInputElement
  error: HTMLElement
}

function field(
  name: Field,
  label: string,
  attrs: Record<string, string | boolean>,
): FieldRow {
  const id = `give-${name}`
  const input = h('input', {
    id,
    name,
    'aria-describedby': `${id}-error`,
    ...attrs,
  })
  const error = h('p', { id: `${id}-error`, class: 'error', hidden: true })
  const row = h(
    'div',
    { class: 'field' },
    h('label', { for: id }, label),
    input,
    error,
  )
  return { row, input, error }
}

function form(page: GivePage, slug: string) {
  document.title = `Give to ${page.name}`
  const amounts = page.amounts.map(fromWire)
  const minimum = fromWire(page.minimum)
  const maximum = fromWire(page.maximum)
  const wording: Wording | null = page.giftAid
    ? wordingFor(page.giftAid.wordingVersion)
    : null

  /** This attempt's key: a new one only when the server says it is spent. */
  let attempt = newId()
  let sending = false

  // ── amount ──
  const other = h('input', {
    id: 'give-other',
    name: 'other',
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    placeholder: '0.00',
    'aria-label': 'Other amount in pounds',
    'aria-describedby': 'give-amount-error',
  })
  const choice = (value: string, label: Child, checked = false) => {
    const radio = h('input', { type: 'radio', name: 'amount', value, checked })
    radio.checked = checked
    return {
      radio,
      label: h('label', { class: 'choice' }, radio, h('span', {}, label)),
    }
  }
  const buttons = amounts.map((pence, i) =>
    choice(pence.toString(), formatPence(pence), i === 1),
  )
  const otherChoice = choice('other', 'Other')
  const otherRow = h(
    'div',
    { class: 'other', hidden: true },
    h('span', { 'aria-hidden': 'true' }, '£'),
    other,
  )
  const amountError = h('p', {
    id: 'give-amount-error',
    class: 'error',
    hidden: true,
  })
  const amountSet = h(
    'fieldset',
    {},
    h('legend', {}, 'Amount'),
    h(
      'div',
      { class: 'choices' },
      ...buttons.map((b) => b.label),
      otherChoice.label,
    ),
    otherRow,
    h(
      'p',
      { class: 'muted small' },
      `From ${formatPence(minimum)} to ${formatPence(maximum)}.`,
    ),
    amountError,
  )

  /** The amount chosen, in pence; null while "other" doesn't hold one. */
  const amount = (): bigint | null => {
    if (otherChoice.radio.checked) return parsePounds(other.value)
    const picked = buttons.find((b) => b.radio.checked)
    return picked ? BigInt(picked.radio.value) : null
  }
  const inRange = (pence: bigint | null): pence is bigint =>
    pence !== null && pence >= minimum && pence <= maximum

  // ── who ──
  const first = field('firstName', 'First name', {
    type: 'text',
    autocomplete: 'given-name',
    maxlength: '200',
  })
  const last = field('lastName', 'Last name', {
    type: 'text',
    autocomplete: 'family-name',
    maxlength: '200',
  })
  const email = field('email', 'Email', {
    type: 'email',
    autocomplete: 'email',
    inputmode: 'email',
    maxlength: '320',
  })

  // ── Gift Aid ──
  const tick = h('input', {
    type: 'checkbox',
    id: 'give-giftaid',
    name: 'giftAid',
  })
  const declaration = h('span', {})
  const line1 = field('addressLine1', 'House name or number', {
    type: 'text',
    autocomplete: 'address-line1',
    maxlength: '200',
  })
  const postcode = field('postcode', 'Postcode', {
    type: 'text',
    autocomplete: 'postal-code',
    maxlength: '20',
  })
  const home = wording
    ? h(
        'div',
        { class: 'home', hidden: true },
        h('p', {}, wording.taxpayer),
        h('p', { class: 'muted small' }, wording.address),
        line1.row,
        postcode.row,
        h('p', { class: 'muted small' }, wording.notify),
      )
    : null
  const giftAid = wording
    ? h(
        'fieldset',
        { class: 'giftaid' },
        h('legend', {}, 'Gift Aid'),
        h('p', { class: 'lead' }, wording.heading),
        h('p', { class: 'muted small' }, wording.intro),
        h('label', { class: 'tick', for: 'give-giftaid' }, tick, declaration),
        home,
      )
    : null

  const notice = h('p', { class: 'notice', role: 'alert', hidden: true })
  const submit = h('button', { type: 'submit', class: 'primary' })

  const fields: Record<Field, { input: HTMLElement; error: HTMLElement }> = {
    amount: { input: other, error: amountError },
    firstName: first,
    lastName: last,
    email,
    addressLine1: line1,
    postcode,
  }

  const setError = (name: Field, message: string | null) => {
    const f = fields[name]
    f.error.textContent = message ?? ''
    f.error.hidden = message === null
    if (message === null) f.input.removeAttribute('aria-invalid')
    else f.input.setAttribute('aria-invalid', 'true')
  }
  const say = (message: string | null) => {
    notice.textContent = message ?? ''
    notice.hidden = message === null
  }

  /** What follows from the amount: the button's label and the declaration. */
  const reflect = () => {
    otherRow.hidden = !otherChoice.radio.checked
    const pence = amount()
    const shown = inRange(pence) ? formatPence(pence) : null
    submit.textContent = sending ? 'Sending…' : shown ? `Give ${shown}` : 'Give'
    submit.disabled = sending
    if (wording && home) {
      declaration.textContent = wording.declaration(
        shown ?? 'this amount',
        page.name,
      )
      home.hidden = !tick.checked
      if (shown && inRange(pence)) {
        declaration.append(
          h(
            'span',
            { class: 'muted small boost' },
            ` Adds ${formatPence(giftAidOn(pence))} at no cost to you.`,
          ),
        )
      }
    }
  }

  /** The form's own check, as the server will make it. First field at fault. */
  const check = (): { donation: GiveDonation } | { at: Field } => {
    const faults: Array<Field> = []
    const fail = (name: Field, message: string) => {
      setError(name, message)
      faults.push(name)
    }
    ;(Object.keys(fields) as Array<Field>).forEach((name) =>
      setError(name, null),
    )
    const pence = amount()
    if (pence === null)
      fail('amount', 'Enter an amount in pounds, like 20 or 20.50')
    else if (!inRange(pence))
      fail(
        'amount',
        `Choose an amount from ${formatPence(minimum)} to ${formatPence(maximum)}`,
      )
    if (!first.input.value.trim()) fail('firstName', 'Enter your first name')
    if (!last.input.value.trim()) fail('lastName', 'Enter your last name')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.input.value.trim()))
      fail('email', 'Enter your email address')
    const aided = wording !== null && tick.checked
    if (aided) {
      if (!line1.input.value.trim())
        fail('addressLine1', 'Enter your house name or number')
      if (!postcode.input.value.trim()) fail('postcode', 'Enter your postcode')
    }
    if (faults.length > 0 || pence === null)
      return { at: faults.length > 0 ? faults[0] : 'amount' }
    return {
      donation: {
        id: attempt,
        amount: toWire(pence),
        firstName: first.input.value,
        lastName: last.input.value,
        email: email.input.value,
        ...(aided && page.giftAid
          ? {
              giftAid: {
                wordingVersion: page.giftAid.wordingVersion,
                addressLine1: line1.input.value,
                postcode: postcode.input.value,
              },
            }
          : {}),
      },
    }
  }

  const focus = (name: Field) => {
    if (name === 'amount' && !otherChoice.radio.checked)
      buttons[0].radio.focus()
    else fields[name].input.focus()
  }

  const send = async () => {
    if (sending) return
    say(null)
    const checked = check()
    if ('at' in checked) {
      focus(checked.at)
      return
    }
    sending = true
    reflect()
    let donation = checked.donation
    let sent = await sendDonation(slug, donation)
    if (sent.kind === 'duplicate') {
      // The attempt already has a payment page we never got the address
      // of (an answer lost on the way): nobody can pay on it, so start
      // another. Once: a second "duplicate" is not that.
      attempt = newId()
      donation = { ...donation, id: attempt }
      sent = await sendDonation(slug, donation)
    }
    if (sent.kind === 'ok') {
      // Still "Sending…" until Stripe's page replaces this one.
      leaveFor(sent.url)
      return
    }
    sending = false
    reflect()
    switch (sent.kind) {
      case 'invalid': {
        let at: Field | null = null
        for (const p of sent.problems) {
          if (p.field === null) continue
          setError(p.field, p.message)
          at ??= p.field
        }
        if (at) focus(at)
        else say('We couldn’t take those details. Check them and try again.')
        break
      }
      case 'changed':
        say(`${sent.message} Reload this page and try again.`)
        break
      case 'duplicate':
        attempt = newId()
        say('That didn’t go through. Nothing has been taken. Try again.')
        break
      case 'absent':
        absent()
        break
      case 'retry':
        say(RETRY[sent.why])
        break
    }
  }

  const body = h(
    'form',
    { novalidate: true },
    amountSet,
    h(
      'fieldset',
      {},
      h('legend', {}, 'Your details'),
      first.row,
      last.row,
      email.row,
    ),
    giftAid,
    notice,
    submit,
    h(
      'p',
      { class: 'muted small' },
      `You pay by card on Stripe’s secure page. ${page.name} receives your payment directly.`,
    ),
  )
  body.addEventListener('submit', (e) => {
    e.preventDefault()
    void send()
  })
  body.addEventListener('input', reflect)
  body.addEventListener('change', (e) => {
    if (e.target === otherChoice.radio && otherChoice.radio.checked)
      other.focus()
    reflect()
  })
  // Back from Stripe's page (the browser kept this one as it was): the
  // attempt that was sent has its payment page, so the next press is a
  // new one.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return
    attempt = newId()
    sending = false
    say(null)
    reflect()
  })

  show('form', h('h1', {}, `Give to ${page.name}`), body)
  reflect()
}

async function start() {
  if (!route) return absent()
  show('loading', h('p', { class: 'muted' }, 'Loading…'))
  const loaded = await loadPage(route.slug)
  if (loaded.kind === 'absent') return absent()
  if (loaded.kind === 'retry') return unreachable(loaded.why)
  if (route.view === 'thanks') return thanks(loaded.page, route.slug)
  form(loaded.page, route.slug)
}

void start()
