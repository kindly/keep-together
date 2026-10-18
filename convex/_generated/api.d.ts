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
import type * as comms_contracts from "../comms/contracts.js";
import type * as comms_suppressions from "../comms/suppressions.js";
import type * as contacts_contracts from "../contacts/contracts.js";
import type * as contacts_history from "../contacts/history.js";
import type * as contacts_migrations from "../contacts/migrations.js";
import type * as contacts_mutations from "../contacts/mutations.js";
import type * as contacts_notes from "../contacts/notes.js";
import type * as contacts_queries from "../contacts/queries.js";
import type * as contacts_relationships from "../contacts/relationships.js";
import type * as contacts_rules from "../contacts/rules.js";
import type * as contacts_search from "../contacts/search.js";
import type * as contacts_searchProjection from "../contacts/searchProjection.js";
import type * as contacts_seed from "../contacts/seed.js";
import type * as contacts_validators from "../contacts/validators.js";
import type * as contacts_view from "../contacts/view.js";
import type * as contacts_warnings from "../contacts/warnings.js";
import type * as giftaid_actions from "../giftaid/actions.js";
import type * as giftaid_irmark from "../giftaid/irmark.js";
import type * as http from "../http.js";
import type * as lib_authErrors from "../lib/authErrors.js";
import type * as lib_contracts from "../lib/contracts.js";
import type * as lib_lists from "../lib/lists.js";
import type * as lib_migrations from "../lib/migrations.js";
import type * as lib_password from "../lib/password.js";
import type * as lib_tables from "../lib/tables.js";
import type * as lib_tenancy from "../lib/tenancy.js";
import type * as platform_devSeed from "../platform/devSeed.js";
import type * as platform_migrations from "../platform/migrations.js";
import type * as platform_preferences from "../platform/preferences.js";
import type * as platform_qcSeed from "../platform/qcSeed.js";
import type * as platform_tenants from "../platform/tenants.js";
import type * as platform_testSeed from "../platform/testSeed.js";
import type * as platform_testSeedData from "../platform/testSeedData.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "comms/contracts": typeof comms_contracts;
  "comms/suppressions": typeof comms_suppressions;
  "contacts/contracts": typeof contacts_contracts;
  "contacts/history": typeof contacts_history;
  "contacts/migrations": typeof contacts_migrations;
  "contacts/mutations": typeof contacts_mutations;
  "contacts/notes": typeof contacts_notes;
  "contacts/queries": typeof contacts_queries;
  "contacts/relationships": typeof contacts_relationships;
  "contacts/rules": typeof contacts_rules;
  "contacts/search": typeof contacts_search;
  "contacts/searchProjection": typeof contacts_searchProjection;
  "contacts/seed": typeof contacts_seed;
  "contacts/validators": typeof contacts_validators;
  "contacts/view": typeof contacts_view;
  "contacts/warnings": typeof contacts_warnings;
  "giftaid/actions": typeof giftaid_actions;
  "giftaid/irmark": typeof giftaid_irmark;
  http: typeof http;
  "lib/authErrors": typeof lib_authErrors;
  "lib/contracts": typeof lib_contracts;
  "lib/lists": typeof lib_lists;
  "lib/migrations": typeof lib_migrations;
  "lib/password": typeof lib_password;
  "lib/tables": typeof lib_tables;
  "lib/tenancy": typeof lib_tenancy;
  "platform/devSeed": typeof platform_devSeed;
  "platform/migrations": typeof platform_migrations;
  "platform/preferences": typeof platform_preferences;
  "platform/qcSeed": typeof platform_qcSeed;
  "platform/tenants": typeof platform_tenants;
  "platform/testSeed": typeof platform_testSeed;
  "platform/testSeedData": typeof platform_testSeedData;
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

export declare const components: {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
};
