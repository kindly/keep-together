//! Riverside's donors (Convex `platform/testSeedData.ts`): 100 contacts
//! generated from a fixed random seed, so every reseed gets the same
//! people, and the same people the Convex instances had (a test compares
//! the output with `tests/fixtures/convex-riverside.json`, the TS
//! generator's). Pure: payloads for the contact contracts, with links
//! between donors as indexes.
//!
//! The mix exercises the UI: individuals (some in families) and
//! organisations, no households while those are dormant; shared and
//! malformed emails (warnings); addresses without postcodes or abroad;
//! archived contacts; pinned and archived notes; relationships of every
//! seeded type; external identifiers under two types, some people holding
//! both.
//!
//! Additions since the Convex port (field values, acquisition codes) draw
//! from a second generator after the first is done, so the people above
//! stay exactly the Convex ones.

use contacts::types::{
    AddressRow, Addresses, ChannelLabel, Details, EmailRow, Kind, Methods, PhoneRow,
};
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

pub const DONOR_COUNT: usize = 100;
/// The Convex generator's seed.
pub const SEED: u32 = 20261017;
/// The additions' generator ([`extras`]).
pub const EXTRAS_SEED: u32 = 20261024;

/// A source detail under one of the starter categories, with its versions
/// (`sources::SeedDetail`, kept as plain data here).
pub struct SourceDetail {
    pub category: &'static str,
    pub name: &'static str,
    pub description: Option<&'static str>,
    pub start_date: Option<&'static str>,
    pub end_date: Option<&'static str>,
    /// (name, description, start, end); the first replaces the auto `001`.
    pub versions: &'static [Version],
    pub archived: bool,
}

pub type Version = (
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
    Option<&'static str>,
);

const ONLY_001: &[Version] = &[("001", None, None, None)];

/// Source codes under the seeded categories: an agency with two runs, an
/// appeal letter split by audience, a one-night event, and an ended
/// campaign that is archived.
pub const SOURCE_DETAILS: &[SourceDetail] = &[
    SourceDetail {
        category: "Street",
        name: "Wesser",
        description: Some("Wesser street fundraising agency, Bristol and Bath pitches"),
        start_date: Some("2026-03-01"),
        end_date: Some("2026-11-30"),
        versions: &[
            ("001", Some("Spring run"), None, Some("2026-05-31")),
            ("002", Some("Autumn run"), Some("2026-09-01"), None),
        ],
        archived: false,
    },
    SourceDetail {
        category: "Door to door",
        name: "Hometown",
        description: Some("Hometown Fundraising, door to door across Leeds"),
        start_date: None,
        end_date: None,
        versions: ONLY_001,
        archived: false,
    },
    SourceDetail {
        category: "Online",
        name: "Website",
        description: Some("The donate page on our own website"),
        start_date: None,
        end_date: None,
        versions: ONLY_001,
        archived: false,
    },
    SourceDetail {
        category: "Online",
        name: "JustGiving",
        description: None,
        start_date: None,
        end_date: None,
        versions: ONLY_001,
        archived: false,
    },
    SourceDetail {
        category: "Direct mail",
        name: "Xmas25",
        description: Some("Christmas 2025 appeal letter"),
        start_date: Some("2025-11-01"),
        end_date: Some("2026-01-31"),
        versions: &[
            ("Warm", Some("Gave in the last two years"), None, None),
            (
                "Lapsed",
                Some("Last gift more than two years ago"),
                None,
                None,
            ),
        ],
        archived: false,
    },
    SourceDetail {
        category: "Event",
        name: "Gala26",
        description: Some("Spring gala dinner at the Assembly Rooms"),
        start_date: Some("2026-04-18"),
        end_date: Some("2026-04-18"),
        versions: ONLY_001,
        archived: false,
    },
    SourceDetail {
        category: "Event",
        name: "BathHalf25",
        description: Some("Bath Half Marathon 2025 charity places"),
        start_date: Some("2025-01-01"),
        end_date: Some("2025-03-16"),
        versions: ONLY_001,
        archived: true,
    },
    SourceDetail {
        category: "Telephone",
        name: "Reactivation",
        description: Some("Calls to lapsed regular givers"),
        start_date: None,
        end_date: None,
        versions: ONLY_001,
        archived: false,
    },
];

/// The identifier types the donors' rows use.
pub const IDENTIFIER_TYPES: [&str; 2] = ["External reference", "Membership number"];

/// The dropdown field riverside's individuals carry (new in the Rust
/// port: Convex's riverside had no fields), and its options.
pub const FIELD: &str = "Volunteer status";
pub const FIELD_OPTIONS: [&str; 3] = ["Active", "Lapsed", "Prospect"];

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct IdentifierSpec {
    pub key: String,
    #[serde(rename = "type")]
    pub type_name: &'static str,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NoteSpec {
    pub body: &'static str,
    pub pinned: bool,
    pub archived: bool,
}

/// One donor. Child-row keys are the Convex ones (`seed-000-e0`), kept
/// for the comparison; the writer leaves keys to the contracts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DonorSpec {
    /// `contacts.client_key`: the donor's stable handle.
    pub client_key: String,
    pub details: Details,
    pub methods: Methods,
    pub addresses: Addresses,
    pub identifiers: Vec<IdentifierSpec>,
    pub archived: bool,
    pub notes: Vec<NoteSpec>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipSpec {
    pub a: usize,
    pub b: usize,
    /// The type's `labelAB` in `contacts::relationships::UK_RELATIONSHIP_TYPES`.
    #[serde(rename = "type")]
    pub type_label: &'static str,
    pub description: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct World {
    pub donors: Vec<DonorSpec>,
    pub relationships: Vec<RelationshipSpec>,
}

/// mulberry32, as the TS generator: the same sequence on every runtime.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed)
    }

    pub fn float(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    pub fn int(&mut self, n: usize) -> usize {
        (self.float() * n as f64).floor() as usize
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.float() < p
    }

    pub fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.int(xs.len())]
    }
}

const FIRST_NAMES: &[&str] = &[
    "Oliver",
    "Amelia",
    "Mohammed",
    "Priya",
    "Aisha",
    "Chidi",
    "Siobhan",
    "Rhys",
    "Eilidh",
    "Wei",
    "Tomasz",
    "Agnieszka",
    "Kwame",
    "Fatima",
    "Hamza",
    "Niamh",
    "Callum",
    "Zara",
    "Arjun",
    "Leila",
    "Dylan",
    "Grace",
    "Yusuf",
    "Mei",
    "Ifeoma",
    "Gareth",
    "Bronwen",
    "Ravi",
    "Hannah",
    "Jamal",
    "Sofia",
    "Declan",
    "Ama",
    "Anjali",
    "Ewan",
    "Nkechi",
    "Ben",
    "Ruth",
    "Kofi",
    "Aleksandra",
    "Seren",
    "Imran",
    "Chloé",
    "Darius",
    "Margaret",
    "Harjit",
    "Tendai",
    "Róisín",
    "Ahmed",
    "Eleanor",
    "Oluwaseun",
    "Jack",
];

const LAST_NAMES: &[&str] = &[
    "Smith",
    "Jones",
    "Williams",
    "Patel",
    "Khan",
    "Begum",
    "Ahmed",
    "Okafor",
    "Adeyemi",
    "Nowak",
    "Kowalski",
    "Chen",
    "Wong",
    "O'Brien",
    "Murphy",
    "MacDonald",
    "Campbell",
    "Evans",
    "Davies",
    "Hughes",
    "Singh",
    "Kaur",
    "Mensah",
    "Osei",
    "Hussain",
    "Ali",
    "Taylor",
    "Brown",
    "Wilson",
    "Ferreira",
    "Nguyen",
    "Rossi",
    "Byrne",
    "Fraser",
    "Llewellyn",
    "Thompson",
    "Robinson",
    "Clarke",
    "Mahmood",
    "Achebe",
    "Ó Súilleabháin",
    "Smith-Okafor",
    "Van der Berg",
    "Gill",
    "Chowdhury",
    "Nwosu",
    "Reid",
];

// Ungendered only: titles are drawn independently of first names.
const TITLES: &[&str] = &["", "", "", "", "", "Dr", "Dr", "Mx", "Rev", "Prof"];

fn nickname(first: &str) -> &'static str {
    match first {
        "Margaret" => "Peggy",
        "Oluwaseun" => "Seun",
        "Aleksandra" => "Ola",
        "Eleanor" => "Nell",
        "Mohammed" => "Mo",
        _ => "",
    }
}

const ORGANISATIONS: &[&str] = &[
    "St Mary's Primary School PTA",
    "Hackney Rotary Club",
    "Patel & Sons Pharmacy",
    "Greenway Housing Co-operative",
    "The Wilson Family Foundation",
    "Bristol Rovers Supporters' Trust",
    "Leeds Grand Mosque Women's Group",
    "Kirkby Allotment Society",
    "Cardiff Bay Rowing Club",
    "Morrison Engineering Ltd",
    "Guru Nanak Gurdwara Smethwick",
    "Brixton Credit Union",
    "Hope Street Methodist Church",
    "Thames Valley Community Foundation",
    "Ludlow Women’s Institute",
    "Oakfield Bakery",
];

const DOMAINS: &[&str] = &[
    "gmail.com",
    "hotmail.co.uk",
    "outlook.com",
    "btinternet.com",
    "yahoo.co.uk",
    "icloud.com",
    "proton.me",
    "sky.com",
];

// Real towns, plausible postcodes: what a UK charity's records look like.
const PLACES: &[(&str, &str, &str)] = &[
    ("Hackney", "London", "E8 1DY"),
    ("Brixton", "London", "SW9 8HE"),
    ("Clifton", "Bristol", "BS8 4AA"),
    ("Headingley", "Leeds", "LS6 3BN"),
    ("Moseley", "Birmingham", "B13 8JP"),
    ("Didsbury", "Manchester", "M20 2LN"),
    ("Leith", "Edinburgh", "EH6 6QU"),
    ("Partick", "Glasgow", "G11 5RD"),
    ("Canton", "Cardiff", "CF5 1JD"),
    ("Jesmond", "Newcastle upon Tyne", "NE2 3HE"),
    ("", "Ludlow", "SY8 1AZ"),
    ("Kirkby", "Liverpool", "L32 8RR"),
    ("", "Belfast", "BT7 1NN"),
    ("", "Totnes", "TQ9 5RY"),
    ("Smethwick", "Sandwell", "B66 3PQ"),
];

const STREETS: &[&str] = &[
    "High Street",
    "Church Road",
    "Victoria Avenue",
    "Mill Lane",
    "Station Road",
    "Park Terrace",
    "Queens Crescent",
    "Albert Street",
    "Ffordd yr Eglwys",
    "Kingsway",
    "Elm Grove",
    "Canal Walk",
];

const NOTES: &[&str] = &[
    "Prefers a phone call to email. Best after 6pm.",
    "Gift Aid declaration came in by post; scan is in the shared drive.",
    "Met at the summer fete. Keen to volunteer on the stall next year.",
    "Moving house in the spring. Check the address before any mailing.",
    "Mentioned leaving a gift in their will. Follow up gently in the autumn.",
    "Large one-off gift in memory of their mother.",
    "Asked not to be phoned at work.",
    "Large print for any letters, please.",
    "Runs the Saturday food bank rota; knows everyone.",
    "Raised £430 at the sponsored walk.",
    "Speaks Polish and English; happy to translate leaflets.",
    "Returned the last newsletter: \"not known at this address\".",
    "Contact via their daughter, who manages their post.",
    "Matched-giving scheme through their employer; send the form each April.",
];

/// Letters only, accents dropped, lower case (the TS `strip`).
fn strip(s: &str) -> String {
    s.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .filter(char::is_ascii_alphabetic)
        .collect::<String>()
        .to_lowercase()
}

fn key(i: usize, kind: &str, n: u32) -> Option<String> {
    Some(format!("seed-{i:03}-{kind}{n}"))
}

fn client_key(i: usize) -> String {
    format!("seed-donor-{i:03}")
}

struct Gen {
    r: Rng,
    donors: Vec<DonorSpec>,
    /// The drafts' names (organisations: empty), for the shared emails.
    first_names: Vec<&'static str>,
    relationships: Vec<RelationshipSpec>,
    next_external: u32,
}

impl Gen {
    fn address(&mut self, i: usize, label: ChannelLabel) -> AddressRow {
        let (line3, town, postcode) = self.r.pick(PLACES);
        let roll = self.r.float();
        let line1 = format!("{} {}", 1 + self.r.int(180), self.r.pick(STREETS));
        let line2 = if self.r.chance(0.15) {
            format!("Flat {}", 1 + self.r.int(12))
        } else {
            String::new()
        };
        let postcode = if roll < 0.08 {
            String::new() // never captured
        } else if roll < 0.11 {
            format!("{}X", postcode.replace(' ', "")) // typo: warns
        } else {
            postcode.into()
        };
        AddressRow {
            key: key(i, "a", 0),
            label,
            line1,
            line2,
            line3: line3.into(),
            town: town.into(),
            postcode,
            country: "GB".into(),
            is_primary: true,
        }
    }

    fn digits(&mut self, n: usize) -> String {
        (0..n)
            .map(|_| char::from(b'0' + self.r.int(10) as u8))
            .collect()
    }

    fn phone(&mut self) -> String {
        match self.r.int(6) {
            0 | 1 => format!("07{} {}", self.digits(3), self.digits(6)),
            2 => format!("+44 7{} {}", self.digits(3), self.digits(6)),
            3 => format!("020 {} {}", self.digits(4), self.digits(4)),
            4 => format!("0131 {} {}", self.digits(3), self.digits(4)),
            _ => format!("029 {} {}", self.digits(4), self.digits(4)),
        }
    }

    fn individual(&mut self, last_name: Option<&'static str>) -> usize {
        let i = self.donors.len();
        let first = self.r.pick(FIRST_NAMES);
        let last = last_name.unwrap_or_else(|| self.r.pick(LAST_NAMES));
        let deceased = self.r.chance(0.03);
        let local = format!("{}.{}", strip(first), strip(last));
        let mut emails = vec![];
        let roll = self.r.float();
        if roll < 0.05 {
            // Malformed but storable: the contact page warns about these.
            let address = if self.r.chance(0.5) {
                format!("{local}.{}", self.r.pick(DOMAINS))
            } else {
                let d = self.r.pick(DOMAINS);
                format!("{local}@{}", d.split('.').next().unwrap_or(d))
            };
            emails.push(email(i, 0, ChannelLabel::Home, address, true));
        } else if roll < 0.88 {
            let n = if self.r.chance(0.3) {
                self.r.int(99).to_string()
            } else {
                String::new()
            };
            let address = format!("{local}{n}@{}", self.r.pick(DOMAINS));
            emails.push(email(i, 0, ChannelLabel::Home, address, true));
        }
        if self.r.chance(0.15) {
            let f = strip(first);
            let domain = self
                .r
                .pick(&["nhs.net", "council.gov.uk", "ac.uk", "example.co.uk"]);
            let address = format!("{}{}@{domain}", &f[..1], strip(last));
            emails.push(email(i, 1, ChannelLabel::Work, address, false));
        }
        let phones = if self.r.chance(0.6) {
            vec![PhoneRow {
                key: key(i, "p", 0),
                label: ChannelLabel::Home,
                number: self.phone(),
                is_primary: true,
            }]
        } else {
            vec![]
        };
        let year = 1938 + self.r.int(68);
        let title = self.r.pick(TITLES);
        let birth_date = if self.r.chance(0.4) {
            let month = 1 + self.r.int(12);
            let day = 1 + self.r.int(28);
            Some(format!("{year}-{month:02}-{day:02}"))
        } else {
            None
        };
        let deceased_date = if deceased {
            let m = 1 + self.r.int(9);
            let d = self.r.int(10);
            Some(format!("2025-0{m}-1{d}"))
        } else {
            None
        };
        let identifiers = if self.r.chance(0.2) {
            let value = format!("LEGACY-{:04}", self.next_external);
            self.next_external += 1;
            vec![IdentifierSpec {
                key: format!("seed-{i:03}-x0"),
                type_name: IDENTIFIER_TYPES[0],
                value,
            }]
        } else {
            vec![]
        };
        let addresses = if self.r.chance(0.82) {
            vec![self.address(i, ChannelLabel::Home)]
        } else {
            vec![]
        };
        self.donors.push(DonorSpec {
            client_key: client_key(i),
            details: Details {
                client_key: None,
                kind: Kind::Individual,
                title: title.into(),
                first_name: first.into(),
                last_name: last.into(),
                nickname: nickname(first).into(),
                name: String::new(),
                birth_date,
                is_deceased: deceased,
                deceased_date,
            },
            methods: Methods { emails, phones },
            addresses: Addresses { addresses },
            identifiers,
            archived: false,
            notes: vec![],
        });
        self.first_names.push(first);
        i
    }

    fn organisation(&mut self, name: &'static str) -> usize {
        let i = self.donors.len();
        let local: String = strip(name).chars().take(18).collect();
        let emails = if self.r.chance(0.85) {
            let who = self.r.pick(&["info", "hello", "treasurer", "office"]);
            vec![email(
                i,
                0,
                ChannelLabel::Work,
                format!("{who}@{local}.org.uk"),
                true,
            )]
        } else {
            vec![]
        };
        let phones = if self.r.chance(0.7) {
            vec![PhoneRow {
                key: key(i, "p", 0),
                label: ChannelLabel::Work,
                number: self.phone(),
                is_primary: true,
            }]
        } else {
            vec![]
        };
        let addresses = if self.r.chance(0.9) {
            vec![self.address(i, ChannelLabel::Work)]
        } else {
            vec![]
        };
        self.donors.push(DonorSpec {
            client_key: client_key(i),
            details: Details {
                client_key: None,
                kind: Kind::Organization,
                title: String::new(),
                first_name: String::new(),
                last_name: String::new(),
                nickname: String::new(),
                name: name.into(),
                birth_date: None,
                is_deceased: false,
                deceased_date: None,
            },
            methods: Methods { emails, phones },
            addresses: Addresses { addresses },
            identifiers: vec![],
            archived: false,
            notes: vec![],
        });
        self.first_names.push("");
        i
    }
}

fn email(i: usize, n: u32, label: ChannelLabel, address: String, is_primary: bool) -> EmailRow {
    EmailRow {
        key: key(i, "e", n),
        label,
        address,
        is_primary,
    }
}

/// The donors and the relationships between them. Same output on every call.
pub fn generate() -> World {
    let mut g = Gen {
        r: Rng::new(SEED),
        donors: vec![],
        first_names: vec![],
        relationships: vec![],
        next_external: 1,
    };

    // Organisations first, so individuals can work for or govern them.
    let orgs: Vec<usize> = ORGANISATIONS.iter().map(|n| g.organisation(n)).collect();

    // Families: 2–3 individuals sharing a surname, a home address and
    // (usually) one email, so the "also used by" warning shows.
    const FAMILIES: usize = 12;
    for h in 0..FAMILIES {
        let surname = LAST_NAMES[(h * 7 + 3) % LAST_NAMES.len()];
        let size = 2 + g.r.int(2);
        let members: Vec<usize> = (0..size).map(|_| g.individual(Some(surname))).collect();
        let shared = format!("the{}s@{}", strip(surname), g.r.pick(DOMAINS));
        let home = g.address(members[0], ChannelLabel::Home);
        for (n, &m) in members.iter().enumerate() {
            g.donors[m].addresses.addresses = vec![AddressRow {
                key: key(m, "a", 0),
                ..home.clone()
            }];
            if n < 2 && g.r.chance(0.8) {
                let emails = &mut g.donors[m].methods.emails;
                let own: Vec<EmailRow> = emails
                    .iter()
                    .filter(|e| e.label == ChannelLabel::Work)
                    .map(|e| EmailRow {
                        is_primary: false,
                        ..e.clone()
                    })
                    .collect();
                *emails = std::iter::once(email(m, 9, ChannelLabel::Home, shared.clone(), true))
                    .chain(own)
                    .collect();
            }
        }
        let year = 1975 + g.r.int(45);
        let day = 1 + g.r.int(28);
        g.relationships.push(RelationshipSpec {
            a: members[0],
            b: members[1],
            type_label: "Spouse/partner of",
            description: "",
            start_date: Some(format!("{year}-06-{day:02}")),
        });
        if size == 3 {
            g.relationships.push(RelationshipSpec {
                a: members[0],
                b: members[2],
                type_label: "Parent of",
                description: "",
                start_date: None,
            });
        }
    }

    // Everyone else: single individuals, some tied to an organisation.
    while g.donors.len() < DONOR_COUNT {
        let i = g.individual(None);
        let roll = g.r.float();
        if roll < 0.15 {
            let b = g.r.pick(&orgs);
            let description =
                g.r.pick(&["Manager", "Volunteer coordinator", "Pharmacist", ""]);
            g.relationships.push(RelationshipSpec {
                a: i,
                b,
                type_label: "Employee of",
                description,
                start_date: None,
            });
        } else if roll < 0.25 {
            let b = g.r.pick(&orgs);
            let description = g.r.pick(&["Chair", "Treasurer", "Secretary", ""]);
            let year = 10 + g.r.int(15);
            let month = 1 + g.r.int(9);
            g.relationships.push(RelationshipSpec {
                a: i,
                b,
                type_label: "Trustee of",
                description,
                start_date: Some(format!("20{year}-0{month}-01")),
            });
        } else if roll < 0.35 {
            let b = g.r.pick(&orgs);
            g.relationships.push(RelationshipSpec {
                a: i,
                b,
                type_label: "Volunteer for",
                description: "",
                start_date: None,
            });
        }
    }

    // Two supporters abroad: checked like any other address, but no UK
    // postcode warning.
    let abroad = [
        ("14 Rue des Lilas", "", "Lyon", "69003", "FR"),
        ("52 Main Street", "Rathmines", "Dublin", "D06 F2X8", "IE"),
    ];
    for (n, (line1, line3, town, postcode, country)) in abroad.into_iter().enumerate() {
        let m = g.donors.len() - 3 - n;
        let base = g.address(m, ChannelLabel::Home);
        g.donors[m].addresses.addresses = vec![AddressRow {
            line1: line1.into(),
            line2: String::new(),
            line3: line3.into(),
            town: town.into(),
            postcode: postcode.into(),
            country: country.into(),
            ..base
        }];
    }

    // Two unrelated people who share an email (a couple filed separately).
    let (p, q) = (g.donors.len() - 1, g.donors.len() - 2);
    let couple = format!(
        "{}and{}@{}",
        strip(g.first_names[p]),
        strip(g.first_names[q]),
        g.r.pick(DOMAINS)
    );
    for m in [p, q] {
        g.donors[m].methods.emails = vec![email(m, 8, ChannelLabel::Home, couple.clone(), true)];
    }

    // Membership numbers: every fourth individual, in order. No random
    // draw.
    let mut members = 0;
    for (i, donor) in g.donors.iter_mut().enumerate() {
        if donor.details.kind != Kind::Individual {
            continue;
        }
        members += 1;
        if (members - 1) % 4 != 0 {
            continue;
        }
        donor.identifiers.push(IdentifierSpec {
            key: format!("seed-{i:03}-x1"),
            type_name: IDENTIFIER_TYPES[1],
            value: format!("RCT-{members:04}"),
        });
    }

    // Archived: a handful of contacts nobody should mail any more.
    for _ in 0..7 {
        let i = g.r.int(DONOR_COUNT);
        g.donors[i].archived = true;
    }

    // Notes on about a third of contacts: some pinned, some archived.
    for i in 0..g.donors.len() {
        if !g.r.chance(0.32) {
            continue;
        }
        let count = 1 + g.r.int(3);
        for _ in 0..count {
            let archived = g.r.chance(0.15);
            let body = g.r.pick(NOTES);
            let pinned = !archived && g.r.chance(0.25);
            g.donors[i].notes.push(NoteSpec {
                body,
                pinned,
                archived,
            });
        }
    }

    World {
        donors: g.donors,
        relationships: g.relationships,
    }
}

/// What the Rust port adds to each donor, from its own generator so the
/// Convex people are untouched: a "Volunteer status" on about 40 % of
/// individuals (an index into [`FIELD_OPTIONS`]), and an acquisition code
/// (detail, version) on about half of everyone.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Extras {
    pub volunteer: Option<usize>,
    pub acquisition: Option<(&'static str, &'static str)>,
}

/// The acquisition codes the extras draw from: every active version.
pub fn active_codes() -> Vec<(&'static str, &'static str)> {
    SOURCE_DETAILS
        .iter()
        .filter(|d| !d.archived)
        .flat_map(|d| d.versions.iter().map(move |v| (d.name, v.0)))
        .collect()
}

/// One [`Extras`] per donor of [`generate`]. Same output on every call.
pub fn extras(world: &World) -> Vec<Extras> {
    let mut r = Rng::new(EXTRAS_SEED);
    let codes = active_codes();
    world
        .donors
        .iter()
        .map(|d| {
            let volunteer = (d.details.kind == Kind::Individual && r.chance(0.4))
                .then(|| r.int(FIELD_OPTIONS.len()));
            let acquisition = r.chance(0.5).then(|| r.pick(&codes));
            Extras {
                volunteer,
                acquisition,
            }
        })
        .collect()
}
