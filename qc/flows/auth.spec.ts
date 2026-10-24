import { expect, test } from '../fixtures'
import { nextTotp } from '../totp'
import type { Page } from '@playwright/test'
import type { QcUser } from '../fixtures'

// Auth flows (A4): sign in with a password and a TOTP code (the seeded
// secret) into the group's home, the two error messages, sign out (from
// Settings), your account, a group URL while signed out, the reset request, and
// a dead invite link. The timed sign-in (`auth.signIn`) is the worker
// fixture's; these check behaviour. Invites and resets past the request
// need the emailed link, which QC can't read (KEEP_MAIL=log): the Rust
// tests (rs/crates/api/tests/auth.rs) cover them. Every test starts signed
// out in a fresh context, so signing out never ends the session the other
// specs share through storageState.

test.use({ storageState: { cookies: [], origins: [] } })

function route(...ids: Array<string>) {
  test
    .info()
    .annotations.push(
      ...ids.map((description) => ({ type: 'route', description })),
    )
}

async function password(page: Page, email: string, pw: string) {
  await page.goto('/')
  await expect(page).toHaveURL('/sign-in')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(pw)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function signIn(page: Page, user: QcUser) {
  await password(page, user.email, user.password)
  await page.getByPlaceholder('Code').fill(await nextTotp(user.totpSecret))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL(`/t/${user.slug}`)
}

/**
 * The form shows one of our own messages, never a raw error: no stack,
 * no file path, no server text.
 */
async function expectNoRawError(page: Page) {
  await expect(page.locator('body')).not.toContainText(
    /Server Error|Uncaught|Request ID|\.rs:\d+|\.ts:\d+|panicked/,
  )
}

test('sign in with a code lands in your group', async ({ page, users }) => {
  route('/', '/sign-in', '/t/$slug/')
  await signIn(page, users.a)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'qc group',
  )
})

test('a wrong password says so, and nothing more', async ({ page, users }) => {
  route('/sign-in')
  await password(page, users.a.email, `${users.a.password}-wrong`)
  await expect(
    page.getByText('Wrong email or password.', { exact: true }),
  ).toBeVisible()
  await expectNoRawError(page)
  await expect(page).toHaveURL('/sign-in')
  await expect(page.getByPlaceholder('Code')).toHaveCount(0)
})

test('a wrong code says so and asks again', async ({ page, users }) => {
  route('/sign-in')
  await password(page, users.staff.email, users.staff.password)
  await page.getByPlaceholder('Code').fill('000000')
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(
    page.getByText("That code didn't work. Check it and try again.", {
      exact: true,
    }),
  ).toBeVisible()
  await expectNoRawError(page)
  // Not signed in: a group URL still asks for a sign-in.
  await page.goto(`/t/${users.staff.slug}/contacts`)
  await expect(page.getByText('to open this group.')).toBeVisible()
})

test('sign out returns to the sign-in form and stays out', async ({
  page,
  users,
}) => {
  route('/t/$slug/settings', '/sign-in')
  await signIn(page, users.viewer)
  // Sign out lives in Settings.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Settings', exact: true })
    .click()
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Sign out' })
    .click()
  await expect(page).toHaveURL('/sign-in')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.goto(`/t/${users.viewer.slug}/contacts`)
  await expect(page.getByText('to open this group.')).toBeVisible()
})

test('your account shows how you sign in', async ({ page, users }) => {
  route('/account')
  await signIn(page, users.staff)
  await page.goto(`/t/${users.staff.slug}/settings`)
  await page.getByRole('link', { name: 'Your account' }).click()
  await expect(page).toHaveURL('/account')
  await expect(page.getByText(users.staff.email)).toBeVisible()
  await expect(page.getByText('authenticator app', { exact: false })).toBeVisible()
})

test('a group URL while signed out asks you to sign in', async ({ page }) => {
  route('/t/$slug', '/')
  await page.goto('/t/x')
  await expect(page.getByText('to open this group.')).toBeVisible()
  await page.getByRole('link', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/sign-in')
  await expect(page.getByPlaceholder('Email')).toBeVisible()
})

test('a reset request answers the same for any address', async ({ page }) => {
  route('/reset')
  await page.goto('/sign-in')
  await page.getByRole('link', { name: 'Forgot your password?' }).click()
  await expect(page).toHaveURL('/reset')
  await page.getByPlaceholder('Email').fill('nobody-at-all@example.com')
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(
    page.getByText("If that address has an account, we've emailed it a link.", {
      exact: false,
    }),
  ).toBeVisible()
})

test('a dead invite link says so', async ({ page }) => {
  route('/invite')
  await page.goto(`/invite#${'0'.repeat(64)}`)
  await expect(
    page.getByText('This link has expired or was already used.', {
      exact: false,
    }),
  ).toBeVisible()
  // The token is gone from the address bar.
  await expect(page).toHaveURL('/invite')
})
