'use node'
/**
 * Node runtime home for HMRC work (ADR 0017: GovTalk submission, PDFs).
 * The IRmark itself needs only Web Crypto, so it also runs in the default
 * runtime; this action exists to prove the Node path deploys and to host
 * the eventual Gateway client (fetch + polling + receipts).
 */
import { v } from 'convex/values'
import { internalTenantAction } from '../lib/tenancy'
import { computeIrmark } from './irmark'

export const irmark = internalTenantAction({
  args: { message: v.string() },
  handler: async (_ctx, { message }) => computeIrmark(message),
})
