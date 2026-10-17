import { httpRouter } from 'convex/server'
import { auth } from './auth'

// Webhooks (GoCardless, Stripe, email provider) register here. One route per
// provider; the path carries the tenant slug; the handler loads that
// tenant's secret from tenantSettings and verifies the signature before
// calling an internalTenantMutation.
const http = httpRouter()

auth.addHttpRoutes(http)

export default http
