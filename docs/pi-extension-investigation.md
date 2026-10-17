# Pi-style extension management and composition (ngo-go investigation) — carried over

> **Status in keep-together.** Written for ngo-go (Django apps composed
> by `NGO_EXTENSIONS`). ADR 0017 keeps ADR 0010's *direction* — bespoke
> customisation is a different bundle deployed to a dedicated deployment,
> never a per-tenant flag in shared code — so the Django host-API
> proposal below is not being built. What still applies, and should be
> designed in when the first client module arrives:
>
> - **Three version concepts stay distinct**: package release, schema
>   (now two-phase Convex schema changes), and each contract / field
>   group's payload version with its upcaster chain. A rename of a
>   module-owned field is a payload migration, not just a schema change.
> - **Disabling a module needs a data policy** (retain vs remove) and a
>   stated restore policy: a revision saved with a module present must
>   say which groups come back when the module is absent.
> - **Registration must reject duplicate ownership** at startup / in a
>   test: two writers for one contract, two providers for a replaceable
>   slot. "Last import wins" is a bug.
> - **Independent features own independent aggregates** (own counters,
>   revisions, form); fields edited together share the slice's counter.
> - **Cross-aggregate restore is an explicit action** naming its
>   participants, never implicit.
> - **External integrations run after commit** (`ctx.scheduler` /
>   Workpool — Convex gives us the transactional outbox for free), with a
>   restore policy deciding whether a restore re-fires them.
> - The agent-authoring guidance (one canonical recipe per pattern,
>   runnable examples in CI, inventory generated from registries, a
>   support status on every recipe) is the template for `docs/` when
>   modules exist.
>
> The CLAUDE.md drift it flagged (child rows "id-less" vs id-carrying)
> was carried into this repo and is fixed as of 2026-10-17; the
> authoritative rule is ADR 0014 and `docs/inherited-from-ngo-go.md`.

# Pi-style extension management and composition for ngo-go

Investigation, 12 September 2026. Focus: extensions coexisting across behavior, UI, data models, and upgrades. This is a design proposal, not an accepted ADR or an implementation change.

**Recommendation:** develop the existing Django extension mechanism into a small, explicit host API. Pi is a useful reference for registration, lifecycle, packaging, and inspection. ngo-go's typed commands and history should define the boundaries of that API.

The interesting opportunity is that a customization can participate in the same forms, validation, persistence, concurrency, and history as core functionality. The harder problem is keeping that true when several extensions are installed and when their schemas evolve.

## What Pi actually does

I examined upstream Pi at commit [`71dca871bc80`](https://github.com/earendil-works/pi/tree/71dca871bc80b6bc97be37f0ca3189399d651fff), dated 11 September 2026. The former `badlogic/pi-mono` repository redirects to `earendil-works/pi`.

An extension exports a TypeScript factory that receives an `ExtensionAPI`. It registers tools, commands, event handlers, and presentation behavior. Pi discovers local extensions and supports development reloads. Its API provides deliberate places to change the host's behavior; extensions still execute with the process's full permissions. This is a trusted-code architecture, not a security sandbox. [Extension documentation](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/docs/extensions.md).

The loader keeps registrations associated with each extension, including source information. In the inspected implementation, it stages certain runtime changes during factory initialization and commits or discards them according to whether loading succeeds. That ownership is useful: the host can identify where a contribution came from instead of treating plugins as anonymous global mutations. [Loader implementation](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/src/core/extensions/loader.ts).

Composition has event-specific rules. The runner invokes handlers in sequence; tool-result transformations pass their result to subsequent handlers, and a blocking tool-call result stops that chain. Ordinary event errors are reported with the extension path and event; tool-call handlers have different failure behavior. The lesson is to define ordering, return values, and failure semantics for each extension point. Merely providing an event bus leaves these questions unanswered. [Runner implementation](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/src/core/extensions/runner.ts).

Pi packages bundle executable extensions with skills, prompt templates, and themes. They can come from npm, Git, or local paths, with manifests or conventional directories, version/ref pins, resource filters, and user/project settings. Installation and resource activation are separate concepts. For a CRM, the equivalent is a deployable feature package plus explicit instance configuration; npm itself is incidental. [Package documentation](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/docs/packages.md).

Pi's todo example stores state in tool-result details and reconstructs it from the active session branch. This is the closest connection to your history design: extension state participates in the host's history model. ngo-go instead restores a past contract snapshot by writing a new revision. Pi's branch reconstruction does not provide CRM schema migration or reverse external effects. [Todo example](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/examples/extensions/todo.ts).

## What this project already has

| Concern | Existing mechanism | Next useful addition |
|---|---|---|
| Discovery and activation | `NGO_EXTENSIONS` selects Django apps at startup | Extension metadata, compatibility checks, explicit resolved inventory |
| UI contributions | Namespaced URLs and named template slots | Declared slot contracts, contribution ownership and ordering |
| Form composition | Namespaced Pydantic groups via `extend_contract()` | Independently versioned groups and migration checks |
| Persistence composition | `applies_extension()` runs inside the core command transaction | Registration checks and explicit read/restore behavior |
| Larger features | Extension-owned entities, contracts, and revision tables | Public registration API and reusable feature examples |
| Upgrade checks | Stored core contract versions checked for migration chains | Extension-group versions and lifecycle-aware checks |

The concrete example is `example.legacy_ref` in `contacts.ContactDetails`. Its value validates as part of the composed form, persists into `ContactLegacyRef`, and is included in the contact revision. An existing test saves it, defaults it on a subsequent command, then restores it. The example also owns a separate `Note` aggregate with its own history.

Sources: [contracts](../../ngo-go/backend/apps/core/contracts.py), [command execution](../../ngo-go/backend/apps/core/commands.py), [UI slots](../../ngo-go/backend/apps/core/extensions.py), [example extension](../../ngo-go/extensions/example/backend/contracts.py), [extension persistence test](../../ngo-go/backend/tests/test_contacts.py).

The history is a versioned command/snapshot log. Each contract owns a slice of an entity and a separate concurrency counter. State application, extension persistence, and the revision commit together. Restore writes another command rather than rewinding rows. This provides a strong composition boundary, although direct ORM access can bypass it: the conventions are not enforced by a sandbox. [History ADR](decisions/0013-model-layer-versioning.md).

## The gaps that matter for customization

**1. Schema identity is ahead of schema migration.** `ensure_schema()` fingerprints the composed JSON Schema plus the core contract's name, entity, and version. Extension shapes therefore affect history identity. But `extend_contract()` has no extension-group version, and restore migrates only by the core contract version.

For example, renaming `example.legacy_ref` to `example.external_reference` changes the stored schema identity. With the core version unchanged, there is no registered group migration to rename the old payload key. The current `extra="forbid"` validation can reject that old nested data. A saved JSON Schema describes structure; it does not preserve executable validators or their semantics. Core semantic changes already require a version bump; extensions need an equivalent rule.

**2. Disabling code needs a data policy.** Restore drops groups absent from the current composed contract and fills defaultable groups newly present. That bridges shapes, but it is not a complete feature lifecycle. Disabling an app does not itself erase its tables or old revision payloads.

Contact details are currently prefilled from the latest details revision. Consider a value saved with an extension enabled, a details save while it is disabled, then re-enabling it: the newest revision may omit the group while its side table still contains the old value. A later save that defaults the missing group can overwrite that value. This is a code-derived scenario to test explicitly, not a runtime reproduction from this investigation.

The upgrade checker also reports an unknown contract when a disabled extension owned that contract. Distinguish deliberately inactive, unsupported historical, and accidentally missing code. An inactive extension can retain inspectable history while restore of its own commands is unavailable.

**3. Registration does not yet police composition.** Several registries assign dictionary entries without rejecting duplicates. Namespace conventions help, but registering the same contract or `(contract, extension)` hook twice can replace earlier code. Composed fields are sorted by extension name, whereas persistence hooks follow group registration order. UI slots follow registration order too. These are implementation behaviors, not an explicit dependency/ordering contract.

Startup checks should catch duplicate IDs, unknown contract targets, missing persistence handlers where required, incompatible host versions, dependency cycles, and unsupported slot names. Extension-owned writes should be independent of incidental registration order.

**4. Independent features need independent state ownership.** A field group on `ContactDetails` shares its counter. This is appropriate for fields edited together. A membership workflow with its own editing lifecycle should own an extension aggregate linked to Contact, with its own contracts and counters. The current ADR explicitly requires extension-defined contracts to target extension-owned entities because adding a new contract to a core entity would need another core counter column.

**5. Multi-extension restore is still a design problem.** A contact-level restore does not automatically discover and restore an extension-owned aggregate. A membership panel must say what its restore affects. Cross-feature restore should be an explicit action with defined participants, using `command_group()` for atomicity where appropriate. The current restore view also suppresses handled errors and redirects; users need an explanation when a customization prevents restore.

## A proposed Django host API

Keep ordinary Django apps and migrations. Introduce a public extension facade over the existing registries, initially with the current in-tree layout. A registration context should attach extension identity to every field group, handler, action, and UI contribution automatically.

A minimal manifest would declare a stable ID, package version, supported host API range, dependencies, and contributed resources. Keep three version concepts distinct: package release, database migration history, and each field group's payload version. Record the resolved extension set for a deployment; associate the relevant group versions and release identity with history schemas so old behavior can be explained.

Separate extension points by purpose:

- **Fields:** namespaced typed data joining an existing form slice, with validation, persistence, current-value loading, and migration rules.
- **Features:** extension-owned models and commands, surfaced through declared panels, pages, and actions.
- **Workflow actions:** explicit service functions composing existing commands in `command_group()`. They preserve field ownership instead of adding overlapping contracts.
- **Presentation:** contributions to documented slots with declared context and stable ordering. This can remain Jinja and htmx.
- **External integrations:** committed domain changes enqueue durable work in a transactional outbox, with idempotent delivery. A restore policy must decide whether an integration should run. Sending email directly inside a persistence hook would break the existing pure-handler model.

These are proposed capabilities, not APIs already present. Start with fields, features, and presentation; add workflow or integration hooks when an actual client requirement demonstrates the need.

For composition, reject duplicate ownership at startup. Use declared dependencies with a deterministic tie-breaker; add explicit ordering only where meaningful, such as multiple panels in one slot. Avoid allowing several extensions to rewrite arbitrary core payloads. Validation remains subject to the project's blocking-versus-warning policy, and extension hooks must preserve core invariants.

A failed persistence extension must roll back the whole command, as it does now. An optional panel can fail independently with a visible diagnostic. Required extension initialization failures should prevent a deployment from being marked ready. These policies differ because their consequences differ.

A diagnostic command or developer page should show the resolved packages, versions, dependencies, owned contract groups, handlers, slots, and compatibility problems. This is the most useful management feature to borrow from an explicit host API. It makes customization inspectable without requiring a marketplace.

## Composing the UI and models without interference

The host should own page structure and interaction conventions. Extensions contribute identified pieces to that structure. A template filename alone does not describe enough of the contract.

For example, a proposed contact-panel contribution would declare `id=membership.summary`, `slot=contact.panels`, its title, its context/query provider, a template or fragment route, visibility requirements, and ordering. The host supplies the contact identity and common display context, checks availability, and renders the panel chrome. Its fragment and action endpoints independently enforce access checks; hiding a panel is not authorization.

| UI contribution | Model/write ownership | Composition rule |
|---|---|---|
| External reference field inside Contact Details | `external_ref` group, persisted in an extension-owned one-to-one table | Shares the Details form submission, counter, validation display, and restore |
| Membership panel with its own editor | Membership aggregate linked to Contact | Own form, endpoint, counter, and revisions; placed outside the core form |
| Contact toolbar action such as “Enroll member” | Named action using the Membership public command | Unique action ID; host presents label/availability; server rechecks prerequisites |
| Two alternative contact-summary renderers | One explicitly replaceable host slot | Select one configured provider or reject ambiguity; no “last import wins” |

Additive slots can accept several contributions. A replaceable slot must say that it accepts exactly one. This distinction prevents accidental overriding while retaining an intentional route for deep customization. Put each extension's view data under its own key and namespace DOM IDs, route names, htmx events and targets. Scope custom CSS to its panel and use the host's shared design tokens. htmx out-of-band responses should update only the contribution's owned elements or documented host targets, so one panel cannot accidentally replace another panel's errors or save state.

There are two distinct editing experiences here. A field embedded in the main form participates in that form's validation and save semantics. An independent panel saves its own aggregate and must not introduce a nested HTML form. If the product later offers “Save everything,” the host must explicitly compose the operations and their version checks into a transaction; visual proximity does not imply shared persistence.

The existing `form_fields()` and form macros already render nested scalar groups and standard input types, including choices, dates, and checkboxes. Repeating child editors are currently custom contact code: `ROW_GROUPS`, section dispatch, and the email/phone/address template blocks are fixed. A plugin-defined repeating list or new editable section therefore needs a new host contribution contract; it does not automatically work just because Pydantic can validate it. [Form description](../../ngo-go/backend/apps/core/forms.py), [form macros](../../ngo-go/backend/templates/macros/forms.html), [contact form](../../ngo-go/backend/templates/contacts/_form.html), [section routing](../../ngo-go/backend/apps/contacts/views.py).

For models, retain composition through relationships. Two extensions can each own a one-to-one table linked to Contact without adding columns or replacing the Contact class. A richer feature owns a separate aggregate. Core code should not import those tables. An extension that genuinely depends on another extension declares that dependency and calls its public service; neither directly writes the other's rows. Explicit FK and deletion policies remain part of each model design.

This also clarifies business-rule conflicts. Additive fields are usually independent; two extensions imposing incompatible rules on the same workflow are not made compatible by namespacing. Use one configured policy provider where a decision is exclusive, or an explicitly documented combiner where several policies can participate. Detect known incompatibilities before startup and test the supported combinations. No plugin framework can infer arbitrary business-rule compatibility.

## Composing upgrades

An installed combination has at least three compatibility problems: host API and package dependencies; the Django database migration graph; and migrations of historical contract payloads. They need separate checks. The existing example already declares Django migration dependencies on core and contacts; that orders database changes, but does not migrate old revision JSON. [Example migration](../../ngo-go/extensions/example/backend/migrations/0004_noterevision_restored_from_alter_noterevision_group_and_more.py).

For an external-reference rename, a release should carry both the database migration and a field-group payload upcaster. Stored schemas would identify, for example, core `ContactDetails` v1 plus `external_ref` group v1. A proposed restore planner migrates the core-owned slice and each extension-owned group independently, reassembles the currently supported composition, validates it, previews any omitted groups, and then executes it. Each upcaster owns its namespace; it must not silently rewrite another extension's payload. Cross-owner transformations require an explicit coordinated migration.

A release procedure should:

1. Resolve one concrete set of extension releases and shared Python dependencies. Reject conflicting requirements, missing dependencies, duplicate providers, and cycles.
2. Check the database migration graph and historical payload migration coverage for that set, including the deliberately inactive extensions policy.
3. On a disposable copy or representative fixtures, migrate the database and exercise old payloads, current-value loading, composed forms, and restores. The current static migration check only proves steps are registered; it does not prove their code works.
4. Activate the tested code and registry with a restart. Use staged additive schema changes when old and new application processes need to coexist. A failed data migration may require a forward fix or database recovery; changing the package pin back is not a universal rollback.

Keep the supported combination set deliberate: stock, each supported extension, and the actual deployed bundles, with interaction-focused tests for shared contracts and slots. Pairwise coverage is useful but does not establish that every larger combination works. In-process Python extensions share dependencies, so two incompatible versions of a common library should normally make the bundle unsatisfiable instead of being assumed isolated.

## Deployment and product boundaries

Use a deployment lock/manifest and pinned Python dependencies for production. Resolve and validate packages before release, run database and payload compatibility checks, then restart into an immutable registry. Pi-style reload is useful inspiration for development feedback, but runtime Django app unloading and schema changes should not become ordinary user toggles.

Define lifecycle operations separately: install code, migrate data, activate behavior, deactivate behavior while retaining data, and explicitly remove data. Before restoring an old revision under a different extension set, show which groups can be restored and which cannot. A partial restore should be an explicit choice, not a silent claim that the whole old state returned.

The accepted architecture currently uses one instance per charity. The newer [hosting ADR 0016](decisions/0016-tiered-hosting-schema-per-tenant.md) is **draft** and proposes shared deployments plus dedicated instances. Its extension consequence is material: `INSTALLED_APPS` and the present registries are process-global. Per-request app loading is not an available tenant customization mechanism. Even gating a panel per tenant leaves the registered contract groups in place unless composition is separately redesigned.

For that proposed shared tier, use a platform-selected package set with tenant-specific declarative configuration. Bespoke executable extensions fit dedicated deployments. Database schemas isolate data layout; they do not isolate arbitrary Python code running in one process.

The community-group brief also favors inexpensive, simple operation. Routine labels, field choices, tags, and saved views should eventually be configuration. Reusable modules can cover common workflows; trusted bespoke extensions cover exceptional requirements. Each should participate in versioned data semantics where it affects saved state. Pi's agent runtime is not required to achieve this architecture.

## Teaching agents to build extensions correctly

The authoring experience is part of the extension design. An agent should be able to discover the supported mechanisms, choose a pattern, follow an executable example, and obtain useful feedback without reconstructing the whole application architecture. Documentation alone cannot enforce ownership or prove arbitrary extensions compatible; the host API and checks must support what the instructions promise.

Pi's extension guide provides a useful documentation pattern: a quick start, lifecycle overview, typed API reference, state-management guidance, and a catalog mapping use cases to working examples. That is evidence of how it explains its API, not a measured claim about agent success. [Pi extension guide](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/docs/extensions.md).

### A short entry point and task-specific recipes

Put a small navigation guide in the repository's agent instructions. It should point to one canonical extension-authoring guide, identify the public imports, state the critical ownership/history rules, and link to the recipe matching the task. Keep architectural rationale in ADRs and detailed signatures in the reference. Avoid copying the same rules into several independently maintained files. An agent-specific skill can route into these resources later; it should not become another source of architectural truth.

The first decision table should be explicit:

| Requested change | Pattern to teach | Boundary to explain |
|---|---|---|
| A few extra fields edited with Contact Details | Namespaced contract group and extension-owned storage | Full-state submission, shared counter, defaults, history |
| A feature with an independent lifecycle | Extension-owned aggregate linked to Contact | Own commands, counter, revisions, and form |
| A dashboard display | Existing registered dashboard partial | Template context, authenticated fragment route, DOM ownership |
| A contact panel or new repeating editor | Proposed host extension point; currently incomplete | Identify the missing generic seam rather than assuming an API exists |
| Rename or change stored extension fields | Payload migration plus database migration where needed | Independent group migration support is currently missing |

Every recipe needs a support status and host version. Keep proposed APIs visibly separate from executable examples; otherwise an agent may confidently write against an interface that exists only in this investigation.

### Explain the entire operation and the reason for each constraint

A field-extension recipe should cover registration, storage, input rendering, submission, validation, persistence, prefill, history, and upgrade behavior. Link to executable files and tests for each stage. Provide complete small examples for separate patterns instead of a single giant example mixing every capability. Run the examples in CI and keep their instructions alongside them.

Teach constraints as cause and effect. For example: “Submit updates through `execute_contract()` with the displayed counter. This keeps extension persistence and the revision in one transaction, and detects another save since the form was loaded.” Also explain where ORM writes belong: inside the registered persistence handler. A blanket “never use `.save()`” would misdescribe the implementation.

For UI contributions, document the slot's available context, placement inside or outside a form, owned DOM region, permitted htmx targets, endpoint authorization, and save/error behavior. Include a rendered reference plus tests that two contributions can coexist. For history, include a concrete before/after payload and restored outcome, including absent extension groups. These examples should expose the semantic decisions an agent must preserve.

### Make the workflow return evidence

An authoring recipe should lead the agent through: inspect supported extension points; choose the ownership pattern; declare contributed fields/models/UI; implement from the closest example; run applicable compatibility and behavior checks; report the extension's ownership and the checks actually run. Unsupported requests should produce a precise explanation of the missing host capability and a generic proposed addition, rather than an undocumented override.

Generate a read-only capability inventory from the actual registries where possible: available contracts, current composed fields, owners, counters, slots, and handlers. The richer inventory and ownership checks are proposals. Documentation should not advertise them as commands until they exist.

Validation errors should name the conflicting contributions and the corrective action. For example, a proposed ownership check could report: “`membership` registered a second writer for `contacts.ContactDetails`; extend it with a namespaced field group or create an extension-owned aggregate.” Use registration checks, type checks, migration fixtures, and interaction tests for what they can establish. Import restrictions or static checks for direct writes are useful diagnostics, not a security boundary for trusted Python code.

### Keep instructions synchronized, and test whether agents can use them

There is already documentation drift here: [CLAUDE.md](../../ngo-go/CLAUDE.md) describes child payloads as id-less, while [ChildRow](../../ngo-go/backend/apps/contacts/contracts.py) carries IDs and [the handler](../../ngo-go/backend/apps/contacts/handlers.py) reconciles rows by ID. Tests exercise preserved IDs and ownership checks. Reconcile that guidance as a documentation-maintenance task; an agent following it literally could break current behavior. This investigation records the discrepancy without silently changing accepted architectural instructions.

When an API changes, update its recipe, runnable example, and behavioral tests in the same change. Link or generate exact signatures and inventory from code, while keeping explanations of intent human-authored. A change to semantics still needs review even if generated references remain syntactically correct.

Evaluate the authoring experience with fresh agent sessions receiving only the repository and a realistic client request. Proposed tasks: add a field, add an independent feature beside another extension, upgrade an old payload, and diagnose a deliberate registration conflict. Score independently maintained acceptance checks for current behavior, untouched state owned by others, UI coexistence, history preservation, and upgrades. Include unfamiliar variations so copying the example is insufficient. Record interventions, unsupported API guesses, unintended core edits, and time to a passing result; rerun tasks to distinguish repeatable failures from one-off mistakes.

Those agent evaluations have not been run. They would test the documentation and API together. If the same mistake recurs, revise the interface, example, or diagnostic that allowed it, and add a focused regression case. Success is an agent producing a compatible extension from a client request with little need for architectural inference.

## A bounded first experiment

Build two small extensions against the current mechanism before committing to a larger framework:

1. **External reference:** extend contact details with a reference field; exercise a v1-to-v2 rename, disable/re-enable, and restore from both versions.
2. **Membership:** own a Contact-linked aggregate, its own concurrency counter and revisions, and a contact-page panel/action. This tests an independent feature without changing the contact's owned fields.

Run them separately and together. Deliberately introduce a duplicate registration and a failing persistence hook. Exercise a concurrent core edit, a shared-form extension edit, and an independent membership edit. Confirm the intended conflicts and that failed saves leave neither partial state nor successful revisions.

Success means both extensions compose with understandable ordering and errors; extension data survives the chosen disable/re-enable policy; supported historical payloads migrate and restore; core invariants remain intact; and adding the second feature requires no client-specific branch in core. Common extension points added during the experiment must be generic and documented.

Use the existing stock/example CI variants as a starting point, adding the paired configuration and upgrade fixtures. Decide on a broader packaging framework only after this exposes the real missing seams. The first implementation priority is independent extension-group migration and lifecycle semantics, followed by registration validation and an inventory view.

Verification scope: inspected repository implementation, existing tests, architectural decisions, and pinned upstream Pi source. No application code changed, no migrations ran, and no test suite or runtime reproductions ran for this research-only change.
