import type { ReactNode } from 'react'
import { useClaimsGiftAid } from '../lib/tenant'

/**
 * A Gift Aid page's content, or, in a group that doesn't claim Gift Aid
 * (Settings › Gift Aid; plan stripe.sv, S5), a line saying so: the links
 * to these pages are hidden there, but a bookmark still lands on them.
 * Nothing recorded is touched: switching Gift Aid back on shows it all.
 */
export function GiftAidOnly({ children }: { children: ReactNode }) {
  if (useClaimsGiftAid()) return children
  return (
    <main className="mx-auto max-w-lg p-6">
      <p data-testid="no-gift-aid">
        This group doesn’t claim Gift Aid, so there is nothing here. An admin
        can change that in Settings, under Gift Aid.
      </p>
    </main>
  )
}
