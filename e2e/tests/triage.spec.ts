import { expect, test } from '@playwright/test'
import { createUser, signIn } from './identity'

const TENANT = '/api/tenants/detect-respond'

test('triaged alerts wait in the queue until opened as a case or dismissed', async ({ page, request }) => {
  const admin = await createUser(request, ['casemgr-detect-respond-admin'])
  await signIn(page, admin)
  const token = await page.request.post(`${TENANT}/tokens`, {
    data: { name: 'e2e-triage', scopes: ['alerts:write'], expires_in_days: 1 },
  })
  expect(token.status()).toBe(201)
  const headers = { Authorization: `Bearer ${(await token.json()).token}` }
  const run = Date.now()
  for (const title of [`Phish ${run}`, `Scanner ${run}`]) {
    const response = await page.request.post(`${TENANT}/webhooks/elastic`, {
      params: { template: 'phishing', triage: 'true' },
      data: { title },
      headers,
    })
    expect((await response.json()).queued).toBe(true)
  }

  await page.getByRole('link', { name: 'Triage' }).click()
  await expect(page.getByRole('heading', { name: `Scanner ${run}` })).toBeVisible()
  await page.getByLabel(`Reason for Scanner ${run}`).fill('Known vulnerability scanner')
  await page.getByRole('listitem').filter({ hasText: `Scanner ${run}` }).getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByRole('heading', { name: `Scanner ${run}` })).toBeHidden()

  await page.getByLabel(`Reason for Phish ${run}`).fill('User entered credentials')
  await page.getByRole('listitem').filter({ hasText: `Phish ${run}` }).getByRole('button', { name: 'Open case' }).click()
  await expect(page.getByRole('heading', { name: `Phish ${run}` })).toBeVisible()
  await expect(page).toHaveURL(/\/cases\/\d+$/)
})
