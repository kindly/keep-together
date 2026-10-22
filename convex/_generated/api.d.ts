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
import type * as comms_rules from "../comms/rules.js";
import type * as comms_suppressions from "../comms/suppressions.js";
import type * as contacts_contracts from "../contacts/contracts.js";
import type * as contacts_fieldTypes from "../contacts/fieldTypes.js";
import type * as contacts_fields from "../contacts/fields.js";
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
import type * as lib_appSchema from "../lib/appSchema.js";
import type * as lib_authErrors from "../lib/authErrors.js";
import type * as lib_authUser from "../lib/authUser.js";
import type * as lib_contracts from "../lib/contracts.js";
import type * as lib_fieldSlots from "../lib/fieldSlots.js";
import type * as lib_lists from "../lib/lists.js";
import type * as lib_migrations from "../lib/migrations.js";
import type * as lib_password from "../lib/password.js";
import type * as lib_tables from "../lib/tables.js";
import type * as lib_tenancy from "../lib/tenancy.js";
import type * as platform_devSeed from "../platform/devSeed.js";
import type * as platform_migrations from "../platform/migrations.js";
import type * as platform_preferences from "../platform/preferences.js";
import type * as platform_qcProbe from "../platform/qcProbe.js";
import type * as platform_qcSeed from "../platform/qcSeed.js";
import type * as platform_tenants from "../platform/tenants.js";
import type * as platform_testSeed from "../platform/testSeed.js";
import type * as platform_testSeedData from "../platform/testSeedData.js";
import type * as sources_code from "../sources/code.js";
import type * as sources_migrations from "../sources/migrations.js";
import type * as sources_mutations from "../sources/mutations.js";
import type * as sources_queries from "../sources/queries.js";
import type * as sources_rules from "../sources/rules.js";
import type * as sources_seed from "../sources/seed.js";
import type * as sources_validators from "../sources/validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "comms/contracts": typeof comms_contracts;
  "comms/rules": typeof comms_rules;
  "comms/suppressions": typeof comms_suppressions;
  "contacts/contracts": typeof contacts_contracts;
  "contacts/fieldTypes": typeof contacts_fieldTypes;
  "contacts/fields": typeof contacts_fields;
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
  "lib/appSchema": typeof lib_appSchema;
  "lib/authErrors": typeof lib_authErrors;
  "lib/authUser": typeof lib_authUser;
  "lib/contracts": typeof lib_contracts;
  "lib/fieldSlots": typeof lib_fieldSlots;
  "lib/lists": typeof lib_lists;
  "lib/migrations": typeof lib_migrations;
  "lib/password": typeof lib_password;
  "lib/tables": typeof lib_tables;
  "lib/tenancy": typeof lib_tenancy;
  "platform/devSeed": typeof platform_devSeed;
  "platform/migrations": typeof platform_migrations;
  "platform/preferences": typeof platform_preferences;
  "platform/qcProbe": typeof platform_qcProbe;
  "platform/qcSeed": typeof platform_qcSeed;
  "platform/tenants": typeof platform_tenants;
  "platform/testSeed": typeof platform_testSeed;
  "platform/testSeedData": typeof platform_testSeedData;
  "sources/code": typeof sources_code;
  "sources/migrations": typeof sources_migrations;
  "sources/mutations": typeof sources_mutations;
  "sources/queries": typeof sources_queries;
  "sources/rules": typeof sources_rules;
  "sources/seed": typeof sources_seed;
  "sources/validators": typeof sources_validators;
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
