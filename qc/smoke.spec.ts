import { expect, test } from '@playwright/test'

// Proves the pipeline end to end: the production build, qc/serve.mjs and
// its /api proxy, Chromium, and the api answering "signed out" so the
// sign-in form renders (the dev stub's until A4: an email, no password).
test('built app shows the sign-in form', async ({ page }) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'keep-together' }),
  ).toBeVisible()
  await expect(page.getByPlaceholder('Email')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})
