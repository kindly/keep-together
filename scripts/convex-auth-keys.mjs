#!/usr/bin/env node
// Generate the RS256 key pair Convex Auth needs, in the exact shape its
// setup wizard produces (JWT_PRIVATE_KEY on one line, JWKS as JSON).
// Prints JSON {JWT_PRIVATE_KEY, JWKS} to stdout.
import { generateKeyPairSync } from 'node:crypto'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const jwk = publicKey.export({ format: 'jwk' })
process.stdout.write(
  JSON.stringify({
    JWT_PRIVATE_KEY: pem.trimEnd().replace(/\n/g, ' '),
    JWKS: JSON.stringify({ keys: [{ use: 'sig', ...jwk }] }),
  }),
)
