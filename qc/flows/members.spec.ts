import { MAIL_OFF_MESSAGE, expect, mailOff, test } from '../fixtures'

// Settings › Members (A4): the list, an invite (with mail off, its
// refusal), a viewer's read-only view, and B's members not being A's.
// Tests start signed in as A's admin (a fresh session, so within the
// step-up hour).

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
  // A reserved domain: on staging the invite really goes out.
  const email = `invitee-${world.tenants[0].slug}-${Date.now().toString(36)}@qc.keep-together.invalid`
  await page.getByLabel('Email to invite').fill(email)
  await page.getByLabel('Role', { exact: true }).selectOption('viewer')
  await page.getByRole('button', { name: 'Send invite' }).click()
  if (mailOff(world)) {
    // Refused up front (`mail_off`): no invite is made that nobody hears of.
    await expect(
      page.getByText(MAIL_OFF_MESSAGE, { exact: false }),
    ).toBeVisible()
    await expect(page.getByText(`${email} as viewer`)).toHaveCount(0)
    return
  }
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
  await expect(
    page.getByText('No group called', { exact: false }),
  ).toBeVisible()
  await expect(page.getByText(users.b.email)).toHaveCount(0)
})
