import { expect, test } from '../fixtures'

// Settings › Members (A4): the list, an invite, a viewer's read-only
// view, and B's members not being A's. Pending until A3's settings layout
// is on the Rust backend (qc/pending.ts). Tests start signed in as A's
// admin (a dev session, so within the step-up hour).

function route(...ids: Array<string>) {
  test
    .info()
    .annotations.push(
      ...ids.map((description) => ({ type: 'route', description })),
    )
}

test('an admin invites someone', async ({ page, users, world }) => {
  route('/t/$slug/settings/members')
  await page.goto(`/t/${users.a.slug}/settings/members`)
  await expect(page.getByText(users.a.email)).toBeVisible()
  const email = `qc-invitee-${world.tenants[0].slug}-${Date.now().toString(36)}@example.com`
  await page.getByLabel('Email to invite').fill(email)
  await page.getByLabel('Role', { exact: true }).selectOption('viewer')
  await page.getByRole('button', { name: 'Send invite' }).click()
  await expect(page.getByText(`Invite sent to ${email}.`)).toBeVisible()
  await expect(page.getByText(`${email} as viewer`)).toBeVisible()
})

test('a viewer sees the members and changes nothing', async ({
  browser,
  session,
  users,
}) => {
  route('/t/$slug/settings/members')
  const context = await browser.newContext({
    storageState: await session(users.viewer),
  })
  const page = await context.newPage()
  await page.goto(`/t/${users.viewer.slug}/settings/members`)
  await expect(page.getByText(users.a.email)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send invite' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  await context.close()
})

test("B's members are not A's", async ({ page, users }) => {
  route('/t/$slug/settings/members')
  await page.goto(`/t/${users.b.slug}/settings/members`)
  await expect(page.getByText('No group called', { exact: false })).toBeVisible()
  await expect(page.getByText(users.b.email)).toHaveCount(0)
})
