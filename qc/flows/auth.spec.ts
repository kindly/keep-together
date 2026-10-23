import { expect, test } from '../fixtures'
import { runId } from '../timing'
import type { Page } from '@playwright/test'

// Auth flows (factory/plans/qc-suite.sv, step 6): sign up, sign in (into
// a group's home, cash-gifts step 4), the two error messages, sign out
// (from Settings), and a group URL while signed out. The
// timed sign-in (`auth.signIn`) is the worker fixture's; these check
// behaviour. Every test starts signed out in a fresh context, so signing
// out never ends the session the other specs share through storageState.

test.use({ storageState: { cookies: [], origins: [] } })

function route(...ids: Array<string>) {
  test
    .info()
    .annotations.push(
      ...ids.map((description) => ({ type: 'route', description })),
    )
}

/** A new email per call: sign-ups accumulate on the pool, never collide. */
function freshEmail(): string {
  const { parallelIndex, testId } = test.info()
  return `qc-r${runId()}w${parallelIndex}-${testId.slice(0, 8)}-${Date.now().toString(36)}@example.com`
}

async function fillCredentials(page: Page, email: string, password: string) {
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(password)
}

/**
 * The form shows one of our own messages, never the raw error: on a dev
 * deployment that carries the server stack and file paths.
 */
async function expectNoRawError(page: Page) {
  await expect(page.locator('body')).not.toContainText(
    /Server Error|ConvexError|Uncaught|Request ID|\.ts:\d+|convex\//,
  )
}

test('sign up with no group says so', async ({ page }) => {
  route('/')
  await page.goto('/')
  await page
    .getByRole('button', { name: 'New here? Create an account' })
    .click()
  await expect(page.getByText('At least 8 characters.')).toBeVisible()
  await fillCredentials(page, freshEmail(), `qc-${runId()}-signup`)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(
    page.getByText("You don't belong to a group yet.", { exact: false }),
  ).toBeVisible()
})

test('sign up with a weak password says why', async ({ page }) => {
  route('/')
  await page.goto('/')
  await page
    .getByRole('button', { name: 'New here? Create an account' })
    .click()
  await fillCredentials(page, freshEmail(), 'short')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(
    page.getByText('Password must be at least 8 characters.', { exact: true }),
  ).toBeVisible()
  await expectNoRawError(page)
  await expect(
    page.getByRole('button', { name: 'Create account' }),
  ).toBeVisible()
})

test('sign in lands in your group', async ({ page, users }) => {
  route('/', '/t/$slug/')
  await page.goto('/')
  await fillCredentials(page, users.a.email, users.a.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(`/t/${users.a.slug}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'qc group',
  )
})

test('a wrong password says so, and nothing more', async ({ page, users }) => {
  route('/')
  await page.goto('/')
  await fillCredentials(page, users.a.email, `${users.a.password}-wrong`)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(
    page.getByText('Wrong email or password.', { exact: true }),
  ).toBeVisible()
  await expectNoRawError(page)
  await expect(page).toHaveURL('/')
})

test('sign out returns to the sign-in form and stays out', async ({
  page,
  users,
}) => {
  route('/', '/t/$slug/settings')
  await page.goto('/')
  await fillCredentials(page, users.a.email, users.a.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(`/t/${users.a.slug}`)
  // Sign out lives in Settings now that "/" never lists groups.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Settings' })
    .click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.goto(`/t/${users.a.slug}/contacts`)
  await expect(page.getByText('to open this group.')).toBeVisible()
})

test('a group URL while signed out asks you to sign in', async ({ page }) => {
  route('/t/$slug', '/')
  await page.goto('/t/x')
  await expect(page.getByText('to open this group.')).toBeVisible()
  await page.getByRole('link', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByPlaceholder('Email')).toBeVisible()
})
