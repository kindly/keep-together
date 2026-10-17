/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as contacts_contracts from "../contacts/contracts.js";
import type * as contacts_mutations from "../contacts/mutations.js";
import type * as contacts_notes from "../contacts/notes.js";
import type * as contacts_queries from "../contacts/queries.js";
import type * as contacts_relationships from "../contacts/relationships.js";
import type * as contacts_rules from "../contacts/rules.js";
import type * as contacts_seed from "../contacts/seed.js";
import type * as contacts_validators from "../contacts/validators.js";
import type * as contacts_warnings from "../contacts/warnings.js";
import type * as giftaid_actions from "../giftaid/actions.js";
import type * as giftaid_irmark from "../giftaid/irmark.js";
import type * as http from "../http.js";
import type * as lib_contracts from "../lib/contracts.js";
import type * as lib_tables from "../lib/tables.js";
import type * as lib_tenancy from "../lib/tenancy.js";
import type * as platform_devSeed from "../platform/devSeed.js";
import type * as platform_tenants from "../platform/tenants.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "contacts/contracts": typeof contacts_contracts;
  "contacts/mutations": typeof contacts_mutations;
  "contacts/notes": typeof contacts_notes;
  "contacts/queries": typeof contacts_queries;
  "contacts/relationships": typeof contacts_relationships;
  "contacts/rules": typeof contacts_rules;
  "contacts/seed": typeof contacts_seed;
  "contacts/validators": typeof contacts_validators;
  "contacts/warnings": typeof contacts_warnings;
  "giftaid/actions": typeof giftaid_actions;
  "giftaid/irmark": typeof giftaid_irmark;
  http: typeof http;
  "lib/contracts": typeof lib_contracts;
  "lib/tables": typeof lib_tables;
  "lib/tenancy": typeof lib_tenancy;
  "platform/devSeed": typeof platform_devSeed;
  "platform/tenants": typeof platform_tenants;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
