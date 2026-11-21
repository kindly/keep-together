import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { ReadRefused, useStepUp } from '../components/claims-ui'
import { ConfirmDialog } from '../components/confirm-dialog'
import { CodeField, field, primary, small } from '../components/direct-debit'
import type { PickedCode } from '../components/direct-debit'
import {
  useDonationPage,
  useSaveDonationPage,
  useStripeAdmin,
  useStripeStatus,
} from '../lib/data'
import type { DonationPage, StripeStatus } from '../lib/data'
import {
  connectionState,
  givePageUrl,
  pageProblems,
} from '../lib/domain/card-payments'
import type { PageProblems } from '../lib/domain/card-payments'
import { formatPence, parsePounds, penceToInput, refusal } from '../lib/gifts'
import { RustApiError } from '../lib/data/rust/client'
import { useIsAdmin } from '../lib/tenant'

/** How Stripe's form sent the admin back (`api::stripe::Stripe::landing`). */
type Outcome = 'return' | 'refresh'

export const Route = createFileRoute('/t/$slug/settings/stripe')({
  component: StripeSettings,
  validateSearch: (s: Record<string, unknown>): { stripe?: Outcome } =>
    s.stripe === 'return' || s.stripe === 'refresh' ? { stripe: s.stripe } : {},
})

/** What each mode means, in a line for the admin. */
export const MODE_TEXT: Record<StripeStatus['mode'], string> = {
  off: 'Card donations are switched off on this server.',
  fake: 'This server uses a stand-in for Stripe: no real money moves and no card is charged.',
  test: 'Stripe’s sandbox: test cards and test money only, nothing is really charged.',
  live: 'Stripe live: real cards and real money.',
}

const AT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/**
 * Settings › Card donations (Stripe S5): connect the group's own Stripe
 * account (Stripe's hosted form, then back here with `?stripe=return` or
 * `?stripe=refresh`), where it stands, disconnect; then the donation
 * page: its link to copy, its amounts and the source code its gifts get.
 * Admin only, as connecting wants a sign-in within the hour.
 */
function StripeSettings() {
  const admin = useIsAdmin()
  const { stripe: outcome } = Route.useSearch()
  // Back from Stripe's form: what it decided comes by webhook, which is
  // no event of the group's, so the status is read again for a while.
  const status = useStripeStatus(outcome === 'return')
  const writes = useStripeAdmin()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  if (!admin)
    return (
      <p className="text-sm text-neutral-600">
        Card donations are set up by the group’s admins.
      </p>
    )
  const state = status && connectionState(status)

  async function act(f: () => Promise<unknown>, failed: string) {
    setBusy(true)
    setError(null)
    try {
      await stepUp.run(async () => {
        await f()
      })
    } catch (err) {
      setError(describeFailure(err, failed))
    } finally {
      setBusy(false)
    }
  }

  const connect = () =>
    act(async () => {
      const url = await writes.connect()
      // Null: Stripe asks for nothing, and the status just landed.
      if (url === null) return
      window.location.assign(url)
      // Leaving the page: stay busy until it goes.
      await new Promise(() => {})
    }, 'Couldn’t reach Stripe’s form')

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Card donations</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Donors give by card on the group’s donation page. The money goes
          straight to the group’s own Stripe account; Stripe’s fees, refunds and
          disputes are the group’s, in its Stripe Dashboard.
        </p>
      </div>
      {outcome && status?.enabled && (
        <p
          role="status"
          data-testid="stripe-outcome"
          className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
        >
          {outcome === 'refresh'
            ? 'That link to Stripe’s form had expired or been used. Press the button below for a new one.'
            : status.chargesEnabled
              ? 'Back from Stripe: the group can take card donations.'
              : 'Back from Stripe. What Stripe decided shows below once it tells us, usually within a minute.'}
        </p>
      )}
      {status === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <>
          <p data-testid="stripe-mode" className="text-sm text-neutral-700">
            {MODE_TEXT[status.mode]}
          </p>
          {status.enabled && state && (
            <>
              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex gap-2">
                  <dt className="text-neutral-500">Status</dt>
                  <dd data-testid="stripe-connected">{state.label}</dd>
                </div>
                {status.connected && status.accountId && (
                  <div className="flex gap-2">
                    <dt className="text-neutral-500">Account</dt>
                    <dd className="font-mono">{status.accountId}</dd>
                  </div>
                )}
                {status.connected && status.connectedAt !== null && (
                  <div className="flex gap-2">
                    <dt className="text-neutral-500">Since</dt>
                    <dd>{AT.format(status.connectedAt)}</dd>
                  </div>
                )}
              </dl>
              <p
                data-testid="stripe-detail"
                className="text-sm text-neutral-600"
              >
                {state.detail}
              </p>
              {status.failedEvents > 0 && (
                <p
                  role="status"
                  data-testid="stripe-failed-events"
                  className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
                >
                  {status.failedEvents === 1
                    ? '1 message from Stripe couldn’t be handled.'
                    : `${status.failedEvents} messages from Stripe couldn’t be handled.`}{' '}
                  A payment may be missing here: tell whoever runs keep-together
                  for the group.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {state.action && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void connect()}
                    className="rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
                  >
                    {state.action}
                  </button>
                )}
                {status.connected && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setAsking(true)}
                    className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                )}
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}
              <DonationPageSettings status={status} />
            </>
          )}
        </>
      )}
      <ConfirmDialog
        open={asking}
        title="Disconnect Stripe?"
        description="The donation page stops taking gifts until Stripe is connected again. The Stripe account stays the group’s, with its money and its history; what Stripe reports meanwhile is kept for when you reconnect."
        confirm="Disconnect"
        cancel="Stay connected"
        confirmDisabled={busy}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          void act(writes.disconnect, 'Couldn’t disconnect')
        }}
      />
      {stepUp.form}
    </section>
  )
}

/**
 * A failed connect in the admin's words. Stripe failing or refusing both
 * answer `503 stripe_unavailable`, so this says neither "down" nor
 * "refused": only that it didn't finish, and that trying again carries on.
 */
function describeFailure(err: unknown, failed: string): string {
  const kind = err instanceof RustApiError ? err.error.kind : undefined
  if (kind === 'stripe_unavailable')
    return 'Stripe didn’t complete that. Try again in a moment: it carries on from where it got to. If it keeps happening, tell whoever runs keep-together for the group.'
  if (kind === 'forbidden')
    return 'Only an admin who has just signed in can change the Stripe connection.'
  return refusal(err, failed, failed)
}

const label = 'flex flex-col gap-1 text-sm'

/**
 * The donation page: whether it is taking gifts and its link to copy,
 * then its three buttons, the least and most "other amount" takes, and
 * the source code every gift from it gets. No link until all of it is
 * in place: the page answers "not taking donations" until then.
 */
function DonationPageSettings({ status }: { status: StripeStatus }) {
  const page = useDonationPage()
  return (
    <section
      aria-labelledby="donation-page"
      className="mt-2 flex flex-col gap-3 border-t border-neutral-200 pt-4"
    >
      <h3 id="donation-page" className="font-medium">
        Donation page
      </h3>
      {page.error ? (
        <ReadRefused
          error={page.error}
          retry={page.refetch}
          forbidden="The donation page’s settings are for the group’s members."
          failed="The donation page’s settings couldn’t load."
        />
      ) : page.data === undefined ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <>
          <PageLink status={status} page={page.data} />
          <PageEditor page={page.data} />
        </>
      )}
    </section>
  )
}

function PageLink({
  status,
  page,
}: {
  status: StripeStatus
  page: DonationPage
}) {
  const { slug } = Route.useParams()
  const [copied, setCopied] = useState(false)
  const missing = !page.takingDonations
    ? page.sourceCodeId === null
      ? 'Choose the page’s source code below and save: the page takes no donations, and has no link to share, until its gifts have a code.'
      : 'The page’s source code is archived, so the page takes no donations. Choose another below and save.'
    : !status.connected
      ? 'Connect Stripe above: the page can’t take a card until the group has a Stripe account.'
      : !status.chargesEnabled
        ? 'Stripe isn’t taking payments for the group yet (above): the page opens, but a donor can’t pay until it is.'
        : null
  const url = givePageUrl(window.location.origin, slug)
  if (!page.takingDonations || !status.connected)
    return (
      <p data-testid="give-link-missing" className="text-sm text-neutral-600">
        {missing}
      </p>
    )
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-500">The link to share with donors</span>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noopener"
          data-testid="give-link"
          className="font-mono break-all underline"
        >
          {url}
        </a>
        <button
          type="button"
          className={small}
          onClick={() => {
            void navigator.clipboard.writeText(url).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      {missing && (
        <p data-testid="give-link-missing" className="text-amber-800">
          {missing}
        </p>
      )}
    </div>
  )
}

/**
 * The form, started from the page as the server had it (`shown`). When
 * the server's page moves on (another admin saved; the event re-reads
 * it): with nothing typed the form follows it; with something typed it
 * is left alone, and a notice says someone else saved and offers their
 * version. Typing is never replaced unasked (review s5r L4), and a save
 * from a form that is behind is refused by its counter, as before.
 */
function PageEditor({ page }: { page: DonationPage }) {
  const [shown, setShown] = useState(page)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Our own save moves the server's page a moment before its answer
  // reaches the form: that is not someone else's.
  // Only a newer counter is someone else's save: this component can
  // render with our own answer before the page read catches up.
  const behind = !saving && (page.version ?? -1) > (shown.version ?? -1)
  if (behind && !dirty) {
    setShown(page)
    setSaved(false)
  }
  return (
    <>
      {behind && dirty && (
        <div
          role="status"
          data-testid="page-changed"
          className="flex flex-wrap items-baseline gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900"
        >
          <span>
            Another admin saved the donation page while you were editing. What
            you typed is still here, but it can’t be saved over theirs.
          </span>
          <button
            type="button"
            className="underline"
            onClick={() => {
              setShown(page)
              setDirty(false)
              setSaved(false)
            }}
          >
            Load their version
          </button>
        </div>
      )}
      {/* Keyed by the counter it started from: it starts again only when
          this component says so. */}
      <PageForm
        key={shown.version ?? -1}
        page={shown}
        saved={saved}
        onTouched={() => {
          setDirty(true)
          setSaved(false)
        }}
        onSaving={setSaving}
        onSaved={(now) => {
          setShown(now)
          setDirty(false)
          setSaved(true)
        }}
      />
    </>
  )
}

function PageForm({
  page,
  saved,
  onTouched,
  onSaving,
  onSaved,
}: {
  page: DonationPage
  /** This is the page as our own save left it. */
  saved: boolean
  /** Something was typed or picked. */
  onTouched: () => void
  /** A save is in flight. */
  onSaving: (saving: boolean) => void
  /** Saved: the page as the server read it back. */
  onSaved: (now: DonationPage) => void
}) {
  const { slug } = Route.useParams()
  const save = useSaveDonationPage()
  const [amounts, setAmounts] = useState(() => page.amounts.map(penceToInput))
  const [minimum, setMinimum] = useState(() => penceToInput(page.minimum))
  const [maximum, setMaximum] = useState(() => penceToInput(page.maximum))
  const [code, setCode] = useState<PickedCode | null>(() =>
    page.sourceCodeId && page.sourceCode
      ? {
          id: page.sourceCodeId,
          shown: {
            code: page.sourceCode.code,
            isActive: page.sourceCode.isActive,
            startDate: page.sourceCode.startDate,
            endDate: page.sourceCode.endDate,
          },
        }
      : null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The server's own problems for a save it refused, by field.
  const [refused, setRefused] = useState<PageProblems>({})
  const parsed = {
    amounts: amounts.map(parsePounds) as [
      bigint | null,
      bigint | null,
      bigint | null,
    ],
    minimum: parsePounds(minimum),
    maximum: parsePounds(maximum),
  }
  const problems = { ...refused, ...pageProblems(parsed) }
  const ready = Object.keys(pageProblems(parsed)).length === 0 && !busy
  const touched = () => {
    onTouched()
    setRefused({})
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    onSaving(true)
    setError(null)
    try {
      const now = await save(page.version, {
        amounts: parsed.amounts as [bigint, bigint, bigint],
        minimum: parsed.minimum as bigint,
        maximum: parsed.maximum as bigint,
        sourceCodeId: code?.id ?? null,
      })
      onSaved(now)
    } catch (err) {
      if (err instanceof RustApiError && err.error.kind === 'invalid')
        setRefused(
          Object.fromEntries(
            err.error.problems.map((p) => [p.field, p.message]),
          ),
        )
      setError(
        refusal(
          err,
          'Couldn’t save the donation page',
          'Another admin changed the donation page just now: it has been read again, so check it and save again',
        ),
      )
    } finally {
      onSaving(false)
      setBusy(false)
    }
  }

  const amount = (
    name: string,
    text: string,
    value: string,
    set: (v: string) => void,
    problem: string | undefined,
  ) => (
    <label className={label}>
      {text}
      <input
        name={name}
        inputMode="decimal"
        value={value}
        aria-invalid={problem !== undefined}
        onChange={(e) => {
          touched()
          set(e.target.value)
        }}
        className={`${field} w-28`}
      />
      {problem && (
        <span data-problem={name} className="text-xs text-red-700">
          {problem}
        </span>
      )}
    </label>
  )

  return (
    <form
      aria-label="Donation page"
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3"
    >
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-sm text-neutral-500">
          The three amount buttons (£)
        </legend>
        {([0, 1, 2] as const).map((i) =>
          amount(
            `amounts.${i}`,
            ['First', 'Second', 'Third'][i],
            amounts[i],
            (v) => setAmounts(amounts.map((a, j) => (j === i ? v : a))),
            problems[`amounts.${i}`],
          ),
        )}
      </fieldset>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-sm text-neutral-500">
          “Other amount” takes (£)
        </legend>
        {amount('minimum', 'At least', minimum, setMinimum, problems.minimum)}
        {amount('maximum', 'At most', maximum, setMaximum, problems.maximum)}
      </fieldset>
      <p className="text-xs text-neutral-500">
        Never under {formatPence(100n)} or over {formatPence(100_000n)},
        whatever is set here: a larger gift comes by bank transfer.
      </p>
      <CodeField
        code={code}
        label="Source code for gifts from the page"
        onChange={(c) => {
          touched()
          setCode(c)
        }}
      />
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex items-baseline gap-3">
        <button type="submit" disabled={!ready} className={primary}>
          {busy ? 'Saving…' : 'Save donation page'}
        </button>
        {saved && (
          <span role="status" data-testid="page-saved" className="text-sm">
            Saved.
          </span>
        )}
        <Link
          to="/t/$slug/stripe/unmatched"
          params={{ slug }}
          className="ml-auto text-sm underline"
        >
          Card payments to match
        </Link>
      </div>
    </form>
  )
}
