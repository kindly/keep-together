//! The org schema as a whole: every past version migrates to head with its
//! rows intact; money is INTEGER (rule 7); domain crates can't reach the
//! store or the platform (rule 6).

use std::collections::BTreeMap;
use std::path::Path;

use api::schema::org_migrations;
use rusqlite::Connection;
use store::{Store, StoreConfig};

/// Representative rows for each org schema version, inserted after
/// migrating to that version (`FIXTURES[n - 1]` is version n). **A new
/// migration adds its entry here**; the test fails until it does.
const FIXTURES: &[&str] = &[
    // 1: revisions + command groups
    "INSERT INTO command_groups (id, name, actor, at) VALUES (1, 'contact form save', 1, 1000);
     INSERT INTO revisions (id, entity, entity_id, contract, version, counter, payload, actor,
         source, group_id, group_name, at)
     VALUES (1, 'contacts', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 'contacts.details', 1, 0,
         '{\"kind\":\"individual\"}', 1, 'ui', 1, 'contact form save', 1000);",
    // 2: contacts, children, dropdown fields, both FTS variants
    "INSERT INTO contact_number_sequence (id, next) VALUES (1, 10002);
     INSERT INTO contacts (number, id, kind, title, first_name, last_name, nickname, name,
         is_deceased, display_name, sort_name, sort_key)
     VALUES (10001, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 'individual', '', 'Ann', 'Smith', '', '',
         0, 'Ann Smith', 'Smith, Ann', 'smith ann');
     INSERT INTO contact_emails (id, contact_id, position, label, address, address_normalized, is_primary)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f1', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 0, 'home',
         'ann@x.org', 'ann@x.org', 1);
     INSERT INTO contact_phones (id, contact_id, position, label, number, number_normalized, is_primary)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f2', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 0, 'home',
         '0113 496 0000', '01134960000', 1);
     INSERT INTO contact_addresses (id, contact_id, position, label, line1, line2, line3, town,
         postcode, country, is_primary)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f3', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 0, 'home',
         '1 Road', '', '', 'Leeds', 'LS1 1AA', 'GB', 1);
     INSERT INTO contact_fields (id, label, label_normalized, applies_to, is_active)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f4', 'Volunteer status', 'volunteer status',
         '[\"individual\"]', 1);
     INSERT INTO contact_field_options (id, field_id, label, label_normalized, position, is_active, used)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f5', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f4', 'Yes', 'yes', 0, 1, 1);
     INSERT INTO contact_field_values (contact_id, field_id, option_id)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f4',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f5');
     INSERT INTO contact_search_words (rowid, text) VALUES (10001, 'ann smith ann@x.org');
     INSERT INTO contact_search_trigram (rowid, text) VALUES (10001, 'ann smith ann@x.org');",
    // 3: drop the trigram FTS variant (no new tables)
    "",
    // 4: tenant preferences
    "INSERT INTO tenant_preferences (id, staff_can_manage_identifier_types, identifier_types_version)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f6', 1, 1);
     INSERT INTO revisions (id, entity, entity_id, contract, version, counter, payload, actor,
         source, at)
     VALUES (2, 'tenant_preferences', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f6',
         'tenantPreferences.identifierTypes', 1, 1,
         '{\"staffCanManageIdentifierTypes\":true}', 1, 'ui', 2000);",
    // 5: tenant settings
    "INSERT INTO tenant_settings (id, name, nonce, ciphertext, version)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f7', 'webhook', 'AAAAAAAAAAAAAAAA', 'AAAA', 0);",
    // 6: identifiers and their types, notes, relationships and their types
    "UPDATE contacts SET identifiers_version = 1;
     INSERT INTO identifier_types (id, name, name_normalized, is_active)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f6', 'Member no', 'member no', 1);
     INSERT INTO contact_identifiers (id, contact_id, position, type_id, value, value_normalized)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f7', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 0,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f6', 'M123', 'm123');
     INSERT INTO contact_notes (id, contact_id, body, created_by, created_at, edited_by, edited_at)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f8', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
         'Met at the fair', 1, 1000, 1, 1000);
     INSERT INTO contacts (number, id, kind, title, first_name, last_name, nickname, name,
         is_deceased, display_name, sort_name, sort_key)
     VALUES (10002, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0fa', 'organization', '', '', '', '',
         'Leeds Trust', 0, 'Leeds Trust', 'Leeds Trust', 'leeds trust');
     INSERT INTO relationship_types (id, label_ab, label_ba, kind_a, kind_b, is_active)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f9', 'Employee of', 'Employer of', 'individual',
         'organization', 1);
     INSERT INTO relationships (id, contact_a, contact_b, type_id, is_active, description)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0fb', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0fa', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f9', 1, '');",
    // 7: email suppressions
    "INSERT INTO email_suppressions (id, address_normalized, suppressed, reason, since)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0fc', 'ann@x.org', 1, 'bounce', 1000);",
    // 8: source codes
    "INSERT INTO source_codes (id, parent_id, level, name, name_normalized, is_active, used)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1', NULL, 'category', 'Street', 'street', 1, 1),
            ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0a2', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1', 'detail',
             'Wesser', 'wesser', 1, 1),
            ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a2', 'version',
             '001', '001', 1, 1);
     INSERT INTO source_code_deletions (id, deleted) VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0a4', 1);",
    // 9: a contact's acquisition code
    "UPDATE contacts SET acquisition_code_id = '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3',
         acquisition_version = 1;",
    // 10: a field's retire phase, the field and option delete logs
    "UPDATE contact_fields SET retiring = 1, retire_version = 1;
     INSERT INTO contact_field_deletions (id, deleted, delete_version)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1', 3, 0);
     INSERT INTO contact_field_option_deletions (id, delete_version)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0b2', 0);",
    // 11: gifts, allocations, the allocation projection
    "INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, status, entered_by,
         entered_at, client_key, gift_version, status_version)
     VALUES (1, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
         '2026-10-20', 2000, 'cash', 'completed', 1, 1000, 'k1', 0, 1);
     INSERT INTO gift_allocations (id, gift_id, position, source_code_id, amount)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0b2', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1', 0,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', 2000);
     INSERT INTO gift_allocation_index (allocation_id, gift_id, contact_id, source_code_id,
         detail_id, category_id, received_on, amount, status)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0b2', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a2', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a1', '2026-10-20',
         2000, 'completed');",
    // 12: Gift Aid declarations
    "INSERT INTO gift_aid_declarations (id, contact_id, scope, gift_id, made_on, method,
         wording_version, first_name, last_name, address_line1, postcode, cancelled_from,
         entered_by, entered_at)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0c1', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
         'futureAndPast4y', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1', '2026-10-20',
         'staffTickedNoEvidence', 'hmrc-2016-04', 'Ann', 'Smith', '1 Road', 'LS1 1AA',
         NULL, 1, 1000);",
    // 13: the recovery generation (its row is the migration's own)
    "UPDATE recovery SET generation = '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d1';",
    // 14: a declaration's details counter; the v12 row completed once
    "UPDATE gift_aid_declarations SET address_line1 = '2 Road', details_version = 1
     WHERE id = '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c1';
     INSERT INTO revisions (entity, entity_id, contract, version, counter, payload, actor,
         source, at)
     VALUES ('gift_aid_declarations', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c1',
         'giftaid.declarationDetails', 1, 1,
         '{\"firstName\":\"Ann\",\"lastName\":\"Smith\",\"addressLine1\":\"2 Road\",\"postcode\":\"LS1 1AA\"}',
         1, 'ui', 2000);",
    // 15: a Gift Aid claim of the v11 gift (draft), its line, an
    // adjustment row, the number sequence and the HMRC details
    "INSERT INTO gift_aid_claim_number_sequence (id, next) VALUES (1, 2);
     INSERT INTO gift_aid_claims (id, number, status, period_end, earliest_date, line_count,
         donations_amount, reclaim_amount, adjustment_amount, created_by, created_at,
         claim_version, status_version)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1', 1, 'draft', '2026-10-27', '2026-10-20', 1,
         2000, 500, 0, 1, 3000, 0, 0);
     INSERT INTO gift_aid_claim_lines (id, claim_id, position, gift_id, declaration_id,
         contact_id, title, first_name, last_name, house, postcode, overseas, received_on,
         amount, reclaim_amount)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0e2', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1', 0,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c1',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 'Ms', 'Ann', 'Smith', '2', 'LS1 1AA', 0,
         '2026-10-20', 2000, 500);
     INSERT INTO gift_aid_claim_adjustments (id, claim_id, position, gift_id,
         original_claim_id, amount, reason, live)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0e3', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1', 0,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1', 0, 'test', 0);
     INSERT INTO gift_aid_hmrc_details (id, hmrc_reference, regulator, regulator_number,
         official_title, official_first_name, official_last_name, official_postcode,
         official_phone, details_version)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0e4', 'AA12345', 'ccew', 'A1234', '', 'John',
         'Smith', 'AB12 3CD', '01234 567890', 1);",
    // 16: the v11 gift locked to the v15 claim
    "UPDATE gifts SET claim_id = '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1', claim_lock_version = 1
     WHERE id = '0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1';",
    // 17: Direct Debit (the gifts rebuild carries the v11 gift with its
    // claim lock; `the_direct_debit_rebuild_keeps_…` puts a claimed void
    // gift with its reason through it too): a void gift with a reason, a
    // regular gift, its confirmed payment and the gift it became
    "INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, status, void_reason,
         entered_by, entered_at, gift_version, status_version)
     VALUES (3, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e9', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
         '2026-10-21', 500, 'cash', 'void', 'entered twice', 1, 2500, 0, 2);
     INSERT INTO regular_gifts (seq, id, contact_id, amount, frequency, day_of_month, month,
         source_code_id, status, billing_request_id, flow_url, flow_expires_at, mandate_id,
         subscription_id, entered_by, entered_at, terms_version, mandate_version)
     VALUES (1, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', 1000,
         'monthly', 5, NULL, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', 'active', 'BRQ000010',
         'https://pay.example/flow', '2026-11-04T10:00:00.000Z', 'MD000010', 'SB000010', 1,
         1000, 1, 3);
     INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, reference, status,
         entered_by, entered_at, gift_version, status_version)
     VALUES (2, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e6', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
         '2026-11-05', 1000, 'direct_debit', 'PM000010', 'completed', NULL, 3000, 1, 1);
     INSERT INTO gift_allocations (id, gift_id, position, source_code_id, amount)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0e7', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e6', 0,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', 1000);
     INSERT INTO direct_debit_payments (seq, id, payment_id, regular_gift_id, amount,
         charge_date, status, gift_id, version)
     VALUES (1, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e8', 'PM000010',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5', 1000, '2026-11-05', 'confirmed',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e6', 2);",
    // 18: every payment attempt (ADR 0025): a pending instalment and its
    // pending gift, a one-off on the same mandate (no regular gift) and
    // the staff request that took it, and an unmatched payment (no
    // regular gift, no gift)
    "INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, reference, status,
         entered_by, entered_at, gift_version, status_version, provider, provider_payment_id,
         regular_gift_id)
     VALUES (4, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d1', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
         '2026-12-05', 1000, 'direct_debit', 'PM000011', 'pending', NULL, 4000, 1, 1,
         'gocardless', 'PM000011', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5'),
            (5, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d2', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
         '2026-12-09', 2500, 'direct_debit', 'PM000012', 'completed', NULL, 4100, 1, 1,
         'gocardless', 'PM000012', NULL);
     INSERT INTO gift_allocations (id, gift_id, position, source_code_id, amount)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0d3', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d1', 0,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', 1000),
            ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0d4', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d2', 0,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', 2500);
     INSERT INTO direct_debit_payments (seq, id, payment_id, regular_gift_id, mandate_id,
         amount, charge_date, status, reason, gift_id, version)
     VALUES (2, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d5', 'PM000011',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5', 'MD000010', 1000, '2026-12-05', 'pending', NULL,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d1', 1),
            (3, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d6', 'PM000012', NULL, 'MD000010', 2500,
         '2026-12-09', 'confirmed', NULL, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d2', 1),
            (4, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d7', 'PM000013', NULL, 'MD000099', 700,
         '2026-12-10', 'confirmed', NULL, NULL, 1);
     INSERT INTO provider_requests (seq, id, kind, provider, contact_id, regular_gift_id,
         amount, source_code_id, charge_date, provider_ref, requested_by, requested_at, version)
     VALUES (1, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0d8', 'one_off', 'gocardless',
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5', 2500,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', NULL, 'PM000012', 1, 4050, 2);",
    // 19: declaration scans: one accepted onto the v12 declaration with
    // two pages, one discarded draft whose images went, one draft from a
    // phone pairing
    "INSERT INTO declaration_scans (id, via, pairing_id, scanned_by, scanned_at, status,
         declaration_id, reviewed_by, reviewed_at, discard_reason, image_deleted_at,
         deletion_reason, deleted_by, scan_version, review_version, retention_version)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0c5', 'phone', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c6', 1,
         5000, 'accepted', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c1', 1, 5100, NULL, NULL, NULL, NULL,
         2, 1, 0),
            ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0c7', 'direct', NULL, 2, 5200, 'discarded', NULL, 2,
         5300, 'blurred', 9000, 'discarded', NULL, 1, 1, 1),
            ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0c8', 'phone', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c6', 1,
         5400, 'draft', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 0, 0);
     INSERT INTO declaration_scan_pages (id, scan_id, page_no, sha256, width, height, size)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0b5', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c5', 1,
         'aa00000000000000000000000000000000000000000000000000000000000001', 1240, 1754, 180000),
            ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0b6', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c5', 2,
         'aa00000000000000000000000000000000000000000000000000000000000002', 1240, 1754, 150000),
            ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0b7', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c7', 1,
         'aa00000000000000000000000000000000000000000000000000000000000003', 1240, 1754, 90000),
            ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0b8', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0c8', 1,
         'aa00000000000000000000000000000000000000000000000000000000000004', 1240, 1754, 200000);",
    // 20: the dated chain (ADR 0026): an upgrade scheduled on the v17
    // regular gift (its row 1 is the backfill's), split across two codes
    // with a change code, and a payment from a subscription nobody here
    // set up
    "INSERT INTO regular_gift_terms (seq, id, regular_gift_id, effective_from, amount, frequency,
         day_of_month, month, note, withdrawn, origin, entered_by, entered_at, change_code_id,
         state, terms_version, code_version)
     VALUES (10, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f1', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5',
         '2027-01-05', 1200, 'monthly', 5, NULL, 'phone call', 0, 'staff', 1, 5000,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', 'scheduled', 1, 1);
     INSERT INTO regular_gift_term_allocations (id, term_id, position, source_code_id, amount)
     VALUES ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f2', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f1', 0,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', 1000),
            ('0190f0c0a0b0c0d0e0f0a0b0c0d0e0f3', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f1', 1,
         '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', 200);
     INSERT INTO direct_debit_payments (seq, id, payment_id, regular_gift_id, mandate_id,
         amount, charge_date, status, reason, gift_id, version, scheduled_on, subscription_id)
     VALUES (5, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f4', 'PM000014', NULL, 'MD000010', 300,
         '2027-01-09', 'pending', NULL, NULL, 1, '2027-01-09', 'SB000099');",
];

const TENANT: &str = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0ff";

fn head_version() -> usize {
    let mut conn = Connection::open_in_memory().unwrap();
    org_migrations().to_latest(&mut conn).unwrap();
    conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .unwrap() as usize
}

/// Row counts of every ordinary table (FTS shadow tables included).
fn counts(conn: &Connection) -> BTreeMap<String, i64> {
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    tables
        .into_iter()
        .map(|t| {
            let n = conn
                .query_row(&format!("SELECT count(*) FROM \"{t}\""), [], |r| r.get(0))
                .unwrap();
            (t, n)
        })
        .collect()
}

/// An org file at schema `version` with every fixture up to it.
fn file_at(dir: &Path, version: usize) -> BTreeMap<String, i64> {
    std::fs::create_dir_all(dir.join("orgs")).unwrap();
    let mut conn = Connection::open(dir.join(format!("orgs/{TENANT}.db"))).unwrap();
    conn.execute_batch("CREATE TABLE _org (tenant_id TEXT NOT NULL)")
        .unwrap();
    conn.execute("INSERT INTO _org (tenant_id) VALUES (?1)", [TENANT])
        .unwrap();
    let migrations = org_migrations();
    for n in 1..=version {
        migrations.to_version(&mut conn, n).unwrap();
        conn.execute_batch(FIXTURES[n - 1]).unwrap();
    }
    counts(&conn)
}

#[test]
fn every_schema_version_has_a_fixture() {
    assert_eq!(
        FIXTURES.len(),
        head_version(),
        "a new org migration needs its fixture in FIXTURES"
    );
}

#[test]
fn every_past_schema_version_migrates_to_head_with_its_rows() {
    let head = head_version();
    for version in 0..=head {
        let tmp = tempfile::tempdir().unwrap();
        let before = file_at(tmp.path(), version);
        let store = Store::open(StoreConfig {
            dir: tmp.path().to_path_buf(),
            org_migrations: org_migrations(),
            readers: 1,
            max_open: StoreConfig::DEFAULT_MAX_OPEN,
        })
        .unwrap();
        let migrated = store.migrate_all().unwrap();
        assert_eq!(migrated, usize::from(version < head), "v{version}");

        let conn = Connection::open(tmp.path().join(format!("orgs/{TENANT}.db"))).unwrap();
        let (v, ok): (i64, String) = conn
            .query_row(
                "SELECT (SELECT user_version FROM pragma_user_version),
                        (SELECT integrity_check FROM pragma_integrity_check)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((v as usize, ok.as_str()), (head, "ok"), "v{version}");
        // Every table that survives keeps its rows.
        let after = counts(&conn);
        for (table, n) in &before {
            if let Some(m) = after.get(table) {
                assert_eq!(m, n, "v{version}: {table}");
            }
        }
        // And the app reads them: search finds the fixture contact.
        if version >= 2 {
            let hits: i64 = conn
                .query_row(
                    "SELECT count(*) FROM contact_search_words WHERE contact_search_words MATCH 'smith'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(hits, 1, "v{version}");
        }
    }
}

#[test]
fn money_is_integer_pence_and_nothing_is_real() {
    let mut conn = Connection::open_in_memory().unwrap();
    org_migrations().to_latest(&mut conn).unwrap();
    let columns: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT m.name, p.name, upper(p.type) FROM sqlite_master m, pragma_table_info(m.name) p
             WHERE m.type = 'table' AND m.sql NOT LIKE 'CREATE VIRTUAL%'",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!columns.is_empty());
    for (table, column, ty) in &columns {
        assert!(
            !["REAL", "FLOAT", "DOUBLE", "NUMERIC", "DECIMAL"]
                .iter()
                .any(|bad| ty.contains(bad)),
            "{table}.{column} is {ty}: money is INTEGER pence (rule 7)"
        );
        let lower = column.to_lowercase();
        if lower.contains("amount") || lower.contains("pence") {
            assert_eq!(
                ty, "INTEGER",
                "{table}.{column}: money is INTEGER pence (rule 7)"
            );
        }
    }
}

/// Rule 6: a domain crate depends on `contracts` (and other domain crates
/// through their public functions), never on `store`, `platform`, `auth`
/// or `api`: it can't name an organisation or reach a file.
#[test]
fn domain_crates_cannot_reach_the_store_or_the_platform() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for domain in ["contacts", "sources", "giving", "giftaid", "comms"] {
        let manifest = std::fs::read_to_string(crates.join(domain).join("Cargo.toml"))
            .unwrap_or_else(|e| panic!("{domain}: {e}"));
        let mut section = "";
        for line in manifest.lines().map(str::trim) {
            if line.starts_with('[') {
                section = line;
                continue;
            }
            if section != "[dependencies]" {
                continue;
            }
            let name = line.split(['=', '.', ' ']).next().unwrap_or("");
            assert!(
                !["store", "platform", "auth", "api"].contains(&name),
                "{domain} depends on {name}"
            );
        }
    }
}

/// Every registered contract owns its own `INTEGER NOT NULL DEFAULT 0`
/// counter column on its root table, and every past version can be
/// upcast (Convex's registry meta-tests).
#[test]
fn every_contract_has_its_own_counter_column_and_its_upcasters() {
    let mut conn = Connection::open_in_memory().unwrap();
    org_migrations().to_latest(&mut conn).unwrap();
    let mut owners = BTreeMap::new();
    let registries = [
        &*contacts::REGISTRY,
        &*platform::REGISTRY,
        &*comms::REGISTRY,
        &*sources::REGISTRY,
        &*giving::REGISTRY,
        &*giftaid::REGISTRY,
    ];
    for c in registries.iter().flat_map(|r| r.contracts()) {
        let (ty, notnull, default): (String, bool, Option<String>) = conn
            .query_row(
                "SELECT type, \"notnull\", dflt_value FROM pragma_table_info(?1) WHERE name = ?2",
                [c.entity(), c.counter()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap_or_else(|e| panic!("{}: {}.{}: {e}", c.name(), c.entity(), c.counter()));
        assert_eq!(
            (ty.as_str(), notnull, default.as_deref()),
            ("INTEGER", true, Some("0")),
            "{}",
            c.name()
        );
        if let Some(other) = owners.insert((c.entity(), c.counter()), c.name()) {
            panic!(
                "{} and {other} share {}.{}",
                c.name(),
                c.entity(),
                c.counter()
            );
        }
    }
    for registry in registries {
        assert!(registry.missing_upcasters().is_empty());
    }
}

/// Rule 6 / M3, the part the compiler can't see: `ctx.tx.read()` is a
/// plain `&Connection` that is only `query_only`, so one line of domain
/// code could switch that off or end the transaction. Domain crates may
/// not contain the strings that would: `query_only`, `authorizer(`,
/// `unchecked_transaction`, or a SQL literal that starts with a
/// transaction-control, `ATTACH` or `PRAGMA` keyword.
#[test]
fn domain_crates_cannot_switch_the_read_view_off() {
    const WORDS: &[&str] = &["query_only", "authorizer(", "unchecked_transaction"];
    const SQL: &[&str] = &[
        "COMMIT",
        "BEGIN",
        "ROLLBACK",
        "SAVEPOINT",
        "RELEASE",
        "ATTACH",
        "DETACH",
        "PRAGMA",
        "END",
    ];
    /// SQL keywords that open a string literal: written as SQL is (all
    /// upper or all lower case), and followed by whitespace or `;`, or the
    /// whole literal. A label such as "End", "Begin" or "Release date" is
    /// not SQL.
    fn literal_keywords(text: &str) -> Vec<String> {
        let mut found = vec![];
        for lit in literals(text) {
            let rest = lit.trim_start();
            let word: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphabetic())
                .collect();
            let upper = word.to_ascii_uppercase();
            let sql_case = word == upper || word == word.to_ascii_lowercase();
            let next = rest[word.len()..].chars().next();
            let ends = next.is_none_or(|c| c.is_whitespace() || c == ';');
            if SQL.contains(&upper.as_str()) && sql_case && ends {
                found.push(upper);
            }
        }
        found
    }
    assert_eq!(
        literal_keywords(r#"x("pragma query_only = 0")"#),
        vec!["PRAGMA"]
    );
    assert_eq!(literal_keywords(r#"x(" COMMIT; BEGIN")"#), vec!["COMMIT"]);
    assert_eq!(literal_keywords(r#"x("COMMIT")"#), vec!["COMMIT"]);
    assert_eq!(
        literal_keywords(r##"x(r#"ROLLBACK TO a"#)"##),
        vec!["ROLLBACK"]
    );
    assert!(
        literal_keywords(
            r#"x("SELECT 1", "Ended", "begins", "End", "Begin", "Release date", '"', "a \" BEGIN")"#
        )
        .is_empty()
    );

    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = vec![];
    for domain in ["contacts", "sources", "giving", "giftaid", "comms"] {
        sources(&crates.join(domain).join("src"), &mut files);
    }
    assert!(!files.is_empty());
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        for word in WORDS {
            assert!(!text.contains(word), "{} mentions {word}", file.display());
        }
        let sql = literal_keywords(&text);
        assert!(
            sql.is_empty(),
            "{}: SQL starting with {sql:?}",
            file.display()
        );
    }
}

fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|x| x == "rs") {
            out.push(path);
        }
    }
}
/// The contents of every string literal in `text` (plain and raw;
/// char literals like `'"'` skipped).
fn literals(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' if bytes.get(i + 2) == Some(&b'\'') => i += 3,
            b'r' if matches!(bytes.get(i + 1), Some(b'"' | b'#')) => {
                let hashes = bytes[i + 1..].iter().take_while(|b| **b == b'#').count();
                let start = i + 2 + hashes;
                if bytes.get(start - 1) != Some(&b'"') {
                    i += 1;
                    continue;
                }
                let close = format!("\"{}", "#".repeat(hashes));
                let end = text[start..].find(&close).map_or(text.len(), |e| start + e);
                out.push(&text[start..end]);
                i = end + close.len();
            }
            b'"' => {
                let start = i + 1;
                let mut j = start;
                while j < bytes.len() && bytes[j] != b'"' {
                    j += if bytes[j] == b'\\' { 2 } else { 1 };
                }
                out.push(&text[start..j.min(text.len())]);
                i = j + 1;
            }
            _ => i += 1,
        }
    }
    out
}

/// ADR 0025: only `completed` is money received. Every SQL literal in
/// server code that reads `gifts` or `gift_allocation_index` filters
/// with `giving::RECEIVED` (spliced in as `{RECEIVED}`, or its negation
/// `{NOT_RECEIVED}`) or says why it
/// reads every status (`/* any status: … */`): a new income, report or
/// Gift Aid read that forgets the filter fails here. Schema steps and
/// plain writes (`UPDATE`, `DELETE`) aren't reads.
#[test]
fn every_gifts_read_counts_only_money_received_or_says_why() {
    /// The literal as the matcher sees it: whitespace runs collapsed to
    /// one space, upper case (SQL is case-insensitive).
    fn normal(lit: &str) -> String {
        lit.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_uppercase()
    }
    /// `FROM`/`JOIN` (or a schema-qualified `MAIN.`) a gifts table, or a
    /// constant in `consts` (`{TABLE}` in a file where `TABLE` is
    /// "gifts").
    fn reads_gifts(lit: &str, consts: &[String]) -> bool {
        let spaced = lit.split_whitespace().collect::<Vec<_>>().join(" ");
        if consts
            .iter()
            .any(|c| spaced.contains(&format!("FROM {c}")) || spaced.contains(&format!("JOIN {c}")))
        {
            return true;
        }
        let n = normal(lit).replace("MAIN.", "");
        ["FROM ", "JOIN "].iter().any(|k| {
            ["GIFTS", "GIFT_ALLOCATION_INDEX"].iter().any(|t| {
                let needle = format!("{k}{t}");
                n.match_indices(&needle).any(|(i, _)| {
                    n[i + needle.len()..]
                        .chars()
                        .next()
                        .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
                })
            })
        })
    }
    fn exempt(lit: &str) -> bool {
        let n = normal(lit);
        n.contains("CREATE TABLE")
            || n.contains("CREATE INDEX")
            || n.starts_with("UPDATE")
            || n.starts_with("DELETE")
    }
    /// Never allowed: a view over gifts (reads through it dodge the
    /// filter), or income summed from a provider's or a request's table
    /// (income comes from gifts).
    fn forbidden(lit: &str) -> bool {
        let n = normal(lit);
        (n.contains("CREATE VIEW") && n.contains("GIFT"))
            || (["DIRECT_DEBIT_PAYMENTS", "PROVIDER_REQUESTS"]
                .iter()
                .any(|t| n.contains(t))
                && ["SUM(", "TOTAL(", "AVG("].iter().any(|f| n.contains(f)))
    }
    fn unfiltered(text: &str) -> Vec<String> {
        // A constant naming a gifts table in this file.
        let consts: Vec<String> = ["TABLE", "ENTITY", "ALLOCATION_INDEX"]
            .iter()
            .filter(|c| {
                ["gifts", "gift_allocation_index"]
                    .iter()
                    .any(|t| text.contains(&format!("{c}: &str = \"{t}\"")))
            })
            .map(|c| format!("{{{c}}}"))
            .collect();
        literals(text)
            .into_iter()
            .filter(|l| {
                forbidden(l)
                    || (reads_gifts(l, &consts)
                        && !exempt(l)
                        && !l.contains("RECEIVED}")
                        && !l.contains("/* any status: "))
            })
            .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect()
    }
    for dodge in [
        r#"x("SELECT sum(amount) FROM gifts WHERE received_on > ?1")"#,
        r#"x("SELECT sum(amount) from
             gifts WHERE x")"#,
        r#"x("SELECT sum(amount) FROM  main.gifts")"#,
        r#"pub const TABLE: &str = "gifts"; x("SELECT sum(amount) FROM {TABLE} WHERE x")"#,
        r#"x("SELECT 1 FROM x JOIN gift_allocation_index i ON 1")"#,
        r#"x("CREATE VIEW income AS SELECT * FROM gifts WHERE {RECEIVED}")"#,
        r#"x("SELECT total(amount) FROM direct_debit_payments WHERE status = 'confirmed'")"#,
    ] {
        assert_eq!(unfiltered(dodge).len(), 1, "{dodge}");
    }
    assert!(
        unfiltered(
            r#"x("SELECT 1 FROM gifts WHERE {RECEIVED}", "SELECT 1 FROM gifts_widen",
               "SELECT 1 FROM gifts WHERE id = ?1 /* any status: one gift */",
               "UPDATE gifts SET status = ?2", "DELETE FROM gift_allocation_index WHERE x",
               "SELECT amount FROM direct_debit_payments WHERE id = ?1")"#
        )
        .is_empty()
    );
    assert_eq!(giving::RECEIVED, "status = 'completed'");

    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = vec![];
    for entry in std::fs::read_dir(&crates).unwrap().flatten() {
        sources(&entry.path().join("src"), &mut files);
    }
    assert!(files.len() > 20);
    let mut found = vec![];
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        for lit in unfiltered(&text) {
            found.push(format!("{}: {lit}", file.display()));
        }
    }
    assert!(
        found.is_empty(),
        "gifts reads without giving::RECEIVED or an `/* any status: … */` note:\n{}",
        found.join("\n")
    );
}

/// Step 15's rebuild checks the foreign keys after it runs, whatever the
/// connection's `foreign_keys` says: a rebuild that orphaned a row fails.
#[test]
fn a_rebuild_that_orphans_a_row_fails_its_step() {
    use rusqlite_migration::{M, Migrations};
    let migrations = Migrations::new(vec![
        M::up(
            "CREATE TABLE p (id TEXT PRIMARY KEY);
             CREATE TABLE c (pid TEXT REFERENCES p (id));
             INSERT INTO p VALUES ('x');
             INSERT INTO c VALUES ('x');",
        ),
        M::up_with_hook("", api::schema::rebuild_with_deferred_keys("DELETE FROM p")),
    ]);
    let mut conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    let err = migrations.to_latest(&mut conn).unwrap_err();
    assert!(err.to_string().contains("point at nothing"), "{err}");
    // The migration's one transaction rolled back: nothing stayed.
    let v: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 0);
    // A rebuild that keeps every parent passes.
    let ok = Migrations::new(vec![
        M::up(
            "CREATE TABLE p (id TEXT PRIMARY KEY);
             CREATE TABLE c (pid TEXT REFERENCES p (id));
             INSERT INTO p VALUES ('x');
             INSERT INTO c VALUES ('x');",
        ),
        M::up_with_hook(
            "",
            api::schema::rebuild_with_deferred_keys(
                "CREATE TABLE hold AS SELECT * FROM p; DROP TABLE p;
                 CREATE TABLE p (id TEXT PRIMARY KEY); INSERT INTO p SELECT * FROM hold;
                 DROP TABLE hold;",
            ),
        ),
    ]);
    let mut conn = Connection::open_in_memory().unwrap();
    ok.to_latest(&mut conn).unwrap();
}

/// Step 17 rebuilds `gifts` (checked at version 17: step 18 rebuilds it
/// again): everything Gift Aid claims (step 16) put there comes through, the claim lock and void reason values, and its
/// two partial indexes, beside Direct Debit's own.
#[test]
fn the_direct_debit_rebuild_keeps_gift_aid_claims_columns_and_indexes() {
    let tmp = tempfile::tempdir().unwrap();
    file_at(tmp.path(), 16);
    let mut conn = Connection::open(tmp.path().join(format!("orgs/{TENANT}.db"))).unwrap();
    // Before the rebuild: a gift claimed and then voided with a reason
    // (what `gifts_claimed_void` finds for the next claim's adjustment).
    conn.execute_batch(
        "INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, status,
             void_reason, claim_id, claim_lock_version, entered_by, entered_at, gift_version,
             status_version)
         VALUES (9, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0ea', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
             '2026-10-22', 700, 'cash', 'void', 'cheque bounced',
             '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1', 1, 1, 2600, 0, 2);",
    )
    .unwrap();
    org_migrations().to_version(&mut conn, 17).unwrap();
    let carried: (String, Option<String>, Option<String>, i64) = conn
        .query_row(
            "SELECT status, void_reason, claim_id, claim_lock_version FROM gifts
             INDEXED BY gifts_claimed_void
             WHERE claim_id = '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1' AND status = 'void'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        carried,
        (
            "void".into(),
            Some("cheque bounced".into()),
            Some("0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1".into()),
            1
        ),
        "a claimed void gift and its reason through the rebuild"
    );
    let (claim, lock): (Option<String>, i64) = conn
        .query_row(
            "SELECT claim_id, claim_lock_version FROM gifts
             WHERE id = '0190f0c0a0b0c0d0e0f0a0b0c0d0e0b1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (claim.as_deref(), lock),
        (Some("0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1"), 1)
    );
    conn.execute_batch(FIXTURES[16]).unwrap();
    let reason: Option<String> = conn
        .query_row(
            "SELECT void_reason FROM gifts WHERE id = '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e9'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(reason.as_deref(), Some("entered twice"));
    for (index, partial) in [
        (
            "gifts_unclaimed",
            "claim_id IS NULL AND status = 'completed'",
        ),
        (
            "gifts_claimed_void",
            "claim_id IS NOT NULL AND status = 'void'",
        ),
        (
            "gifts_by_direct_debit_payment",
            "method = 'direct_debit' AND status = 'completed'",
        ),
        ("gifts_by_contact", ""),
        ("gifts_by_entered_by", ""),
    ] {
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
                [index],
                |r| r.get(0),
            )
            .unwrap_or_else(|e| panic!("{index}: {e}"));
        assert!(sql.contains(partial), "{index}: {sql}");
    }
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('gifts')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for c in ["void_reason", "claim_id", "claim_lock_version"] {
        assert!(columns.iter().any(|x| x == c), "{c} in {columns:?}");
    }
    // Gift Aid's eligibility read still uses its index.
    let plan: String = conn
        .query_row(
            "EXPLAIN QUERY PLAN SELECT id FROM gifts INDEXED BY gifts_unclaimed
             WHERE claim_id IS NULL AND status = 'completed' AND received_on BETWEEN '2026-01-01' AND '2026-12-31'",
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(plan.contains("gifts_unclaimed"), "{plan}");
}

/// Step 18 (ADR 0025) gives every D2 payment exactly one gift with its
/// status: a confirmed payment keeps its gift; one charged back (its gift
/// voided by the payment) has that gift charged back; a void staff made
/// stays void; a payment never confirmed gets a new gift with its status,
/// to its regular gift's code, in the allocation projection; a gift a
/// retry superseded keeps its provider without the payment id. Gift
/// Aid's claimed gift that stopped counting is found by its new index.
#[test]
fn the_unified_gifts_step_gives_every_payment_one_gift_with_its_status() {
    let tmp = tempfile::tempdir().unwrap();
    file_at(tmp.path(), 17);
    let mut conn = Connection::open(tmp.path().join(format!("orgs/{TENANT}.db"))).unwrap();
    // Under D2: PM20 charged back (its gift voided by the payment, in the
    // v15 claim); PM21 confirmed, then voided by staff; PM22 failed, never
    // a gift; PM23 retried on another day (the first gift void, the second
    // completed); and the fixture's PM000010, confirmed.
    conn.execute_batch(
        "INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, reference, status,
             void_reason, claim_id, claim_lock_version, entered_by, entered_at, gift_version,
             status_version)
         VALUES (20, '000000000000000000000000000000a0', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
             '2026-10-05', 1000, 'direct_debit', 'PM20', 'void', 'Charged back (GoCardless)',
             '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1', 1, NULL, 1, 1, 2),
                (21, '000000000000000000000000000000a1', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
             '2026-10-06', 1000, 'direct_debit', 'PM21', 'void', 'wrong donor', NULL, 0,
             NULL, 1, 1, 2),
                (23, '000000000000000000000000000000a3', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
             '2026-10-07', 1000, 'direct_debit', 'PM23', 'void', 'Failed after it was collected',
             NULL, 0, NULL, 1, 1, 2),
                (24, '000000000000000000000000000000a4', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
             '2026-10-14', 1000, 'direct_debit', 'PM23', 'completed', NULL, NULL, 0, NULL, 1,
             1, 1);
         INSERT INTO direct_debit_payments (seq, id, payment_id, regular_gift_id, amount,
             charge_date, status, reason, gift_id, gift_voided, version)
         VALUES (20, '000000000000000000000000000000b0', 'PM20',
             '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5', 1000, '2026-10-05', 'charged_back', 'disputed',
             '000000000000000000000000000000a0', 1, 3),
                (21, '000000000000000000000000000000b1', 'PM21',
             '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5', 1000, '2026-10-06', 'confirmed', NULL,
             '000000000000000000000000000000a1', 0, 2),
                (22, '000000000000000000000000000000b2', 'PM22',
             '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5', 1000, '2026-10-08', 'failed',
             'insufficient funds', NULL, 0, 2),
                (23, '000000000000000000000000000000b3', 'PM23',
             '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5', 1000, '2026-10-14', 'confirmed', NULL,
             '000000000000000000000000000000a4', 0, 4);",
    )
    .unwrap();
    org_migrations().to_latest(&mut conn).unwrap();
    let gift = |payment: &str| -> (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    ) {
        conn.query_row(
            "SELECT g.id, g.provider, g.status, g.void_reason, g.regular_gift_id
             FROM direct_debit_payments p JOIN gifts g ON g.id = p.gift_id
             WHERE p.payment_id = ?1 AND g.provider_payment_id = ?1",
            [payment],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap_or_else(|e| panic!("{payment}: {e}"))
    };
    let regular = Some("0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5".to_owned());
    let gc = Some("gocardless".to_owned());
    assert_eq!(gift("PM000010").2, "completed");
    let pm20 = gift("PM20");
    assert_eq!(
        (pm20.0.as_str(), &pm20.1, pm20.2.as_str(), &pm20.4),
        (
            "000000000000000000000000000000a0",
            &gc,
            "charged_back",
            &regular
        )
    );
    assert_eq!(gift("PM21").2, "void", "a staff void stays");
    let pm22 = gift("PM22");
    assert_eq!(
        (pm22.2.as_str(), pm22.3.as_deref()),
        ("failed", Some("Failed (GoCardless): insufficient funds")),
        "the reason as live processing writes it"
    );
    assert_eq!(gift("PM23").0, "000000000000000000000000000000a4");
    // The new gift: allocated to the regular gift's code, projected.
    let (code, amount, projected): (String, i64, String) = conn
        .query_row(
            "SELECT a.source_code_id, a.amount, x.status FROM gift_allocations a
             JOIN gift_allocation_index x ON x.allocation_id = a.id WHERE a.gift_id = ?1",
            [&pm22.0],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (code.as_str(), amount, projected.as_str()),
        ("0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3", 1000, "failed")
    );
    // The superseded gift: void, its provider kept, out of the pair.
    let superseded: (Option<String>, Option<String>, String) = conn
        .query_row(
            "SELECT provider, provider_payment_id, status FROM gifts
             WHERE id = '000000000000000000000000000000a3'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(superseded, (gc.clone(), None, "void".into()));
    // Exactly one gift per payment, and none disagrees.
    let pairs: i64 = conn
        .query_row(
            "SELECT count(*) FROM direct_debit_payments p
             WHERE (SELECT count(*) FROM gifts g WHERE g.provider_payment_id = p.payment_id) <> 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pairs, 0);
    assert_eq!(
        giving::regular::consistency(&conn).unwrap(),
        Vec::<String>::new()
    );
    // The charged-back claimed gift is what the next claim's adjustment
    // reads.
    let uncounted: Vec<String> = giving::voided_in_claims(&conn)
        .unwrap()
        .into_iter()
        .map(|v| v.id)
        .collect();
    assert_eq!(uncounted, ["000000000000000000000000000000a0"]);
    // And the eligibility read still uses its index.
    let plan: String = conn
        .query_row(
            &format!(
                "EXPLAIN QUERY PLAN SELECT id FROM gifts INDEXED BY gifts_unclaimed
                 WHERE claim_id IS NULL AND {} AND received_on BETWEEN '2026-01-01' AND '2026-12-31'",
                giving::RECEIVED
            ),
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(plan.contains("gifts_unclaimed"), "{plan}");
}

/// Step 19 (ADR 0026): every regular gift gets exactly one applied row,
/// its split the old amount to the old code, in force from its first
/// payment's charge date (or the day it was set up); the old columns are
/// gone and `scheduled_on` is filled.
#[test]
fn the_terms_step_backfills_one_applied_row_per_regular_gift() {
    let tmp = tempfile::tempdir().unwrap();
    file_at(tmp.path(), 18);
    let mut conn = Connection::open(tmp.path().join(format!("orgs/{TENANT}.db"))).unwrap();
    // A second regular gift with no payment yet: in force from the day it
    // was set up (entered_at 2026-10-26).
    conn.execute_batch(
        "INSERT INTO regular_gifts (seq, id, contact_id, amount, frequency, day_of_month, month,
             source_code_id, status, entered_by, entered_at, terms_version, mandate_version)
         VALUES (2, '000000000000000000000000000000c0', '0190f0c0a0b0c0d0e0f0a0b0c0d0e0f0',
             12000, 'yearly', 3, 4, '0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3', 'pending', 1,
             1793000000000, 1, 1);",
    )
    .unwrap();
    org_migrations().to_latest(&mut conn).unwrap();
    type Row = (
        String,
        String,
        i64,
        String,
        String,
        i64,
        String,
        i64,
        String,
    );
    let rows: Vec<Row> = conn
        .prepare(
            "SELECT t.regular_gift_id, t.effective_from, t.amount, t.frequency, t.state,
                 count(a.id), a.source_code_id, sum(a.amount), t.origin
             FROM regular_gift_terms t JOIN regular_gift_term_allocations a ON a.term_id = t.id
             GROUP BY t.id ORDER BY t.regular_gift_id",
        )
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let code = "0190f0c0a0b0c0d0e0f0a0b0c0d0e0a3".to_owned();
    assert_eq!(
        rows,
        [
            (
                "000000000000000000000000000000c0".to_owned(),
                "2026-10-26".to_owned(),
                12000,
                "yearly".to_owned(),
                "applied".to_owned(),
                1,
                code.clone(),
                12000,
                "setup".to_owned()
            ),
            (
                "0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5".to_owned(),
                "2026-11-05".to_owned(),
                1000,
                "monthly".to_owned(),
                "applied".to_owned(),
                1,
                code,
                1000,
                "setup".to_owned()
            ),
        ]
    );
    // The row runs under the gift's subscription; the counter carried over.
    let (sub, setup): (Option<String>, i64) = conn
        .query_row(
            "SELECT t.subscription_id, g.setup_version FROM regular_gift_terms t
             JOIN regular_gifts g ON g.id = t.regular_gift_id
             WHERE g.id = '0190f0c0a0b0c0d0e0f0a0b0c0d0e0e5'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((sub.as_deref(), setup), (Some("SB000010"), 1));
    let old: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('regular_gifts')
             WHERE name IN ('amount', 'frequency', 'day_of_month', 'month', 'source_code_id',
                            'terms_version')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old, 0);
    let unscheduled: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM direct_debit_payments
                     WHERE scheduled_on IS NOT charge_date)
                  + (SELECT count(*) FROM gifts WHERE regular_gift_id IS NOT NULL
                     AND provider_payment_id IS NOT NULL AND scheduled_on IS NOT received_on
                     /* any status: every instalment */)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unscheduled, 0);
    assert_eq!(
        giving::regular::consistency(&conn).unwrap(),
        Vec::<String>::new()
    );
}
