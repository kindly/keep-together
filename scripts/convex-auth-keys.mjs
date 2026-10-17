#!/usr/bin/env node
// Print the Convex Auth key pair as JSON {JWT_PRIVATE_KEY, JWKS}.
// The generator lives in convex-instance.mjs.
import { generateAuthKeys } from './convex-instance.mjs'

process.stdout.write(JSON.stringify(generateAuthKeys()))
