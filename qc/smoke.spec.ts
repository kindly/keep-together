import { expect, test } from '@playwright/test'

// Proves the pipeline end to end: production build (VITE_CONVEX_URL
// compiled in), preview server, Chromium, and Convex Auth settling on
// "signed out" so the sign-in form renders.
test('built app shows the sign-in form', async ({ page }) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'keep-together' }),
  ).toBeVisible()
  await expect(page.getByPlaceholder('Email')).toBeVisible()
  await expect(page.getByPlaceholder('Password')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})
