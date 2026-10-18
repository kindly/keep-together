/**
 * The manual-test instances' donors (platform/testSeed): 100 contacts
 * generated from a fixed random seed, so every reseed and every instance
 * gets the same people. Pure: no Convex functions, only payloads for the
 * contact contracts, with links between donors as array indexes.
 *
 * The mix exercises the UI: individuals (some in families) and
 * organisations, but no households while those are dormant (contacts/seed);
 * shared and malformed emails (warnings); addresses without postcodes or
 * abroad; archived contacts; pinned and archived notes; relationships of
 * every seeded type; external identifiers under two types, some people
 * holding both.
 */
import type { Payloads } from '../contacts/validators'

export const DONOR_COUNT = 100

/**
 * The identifier types the donors' rows use. "External reference" is the
 * name the X2 backfill gave the old single field, so instances seeded
 * before X1 and reseeded since hold one type, not two.
 */
export const IDENTIFIER_TYPES = [
  'External reference',
  'Membership number',
] as const
export type IdentifierTypeName = (typeof IDENTIFIER_TYPES)[number]

/** A relationship type, by its `labelAB` in contacts/seed's UK list. */
export type RelationshipLabel =
  | 'Employee of'
  | 'Trustee of'
  | 'Spouse/partner of'
  | 'Parent of'
  | 'Volunteer for'

export type DonorSpec = {
  /** `contacts.clientKey`: makes each donor's creation idempotent. */
  clientKey: string
  details: Payloads['details']
  methods: Payloads['methods']
  addresses: Payloads['addresses']
  /**
   * External identifiers: the group's old-system id (`LEGACY-nnnn`, on
   * 20 % of people) and a membership number (`RCT-nnnn`, on every fourth
   * individual), by type name.
   */
  identifiers: Array<{ key: string; type: IdentifierTypeName; value: string }>
  archived: boolean
  notes: Array<{ body: string; pinned: boolean; archived: boolean }>
}

export type RelationshipSpec = {
  a: number
  b: number
  type: RelationshipLabel
  description: string
  startDate?: string
}

// mulberry32: tiny, fast, and the same sequence on every runtime.
function rng(seed: number) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)],
  }
}

const FIRST_NAMES = [
  'Oliver',
  'Amelia',
  'Mohammed',
  'Priya',
  'Aisha',
  'Chidi',
  'Siobhan',
  'Rhys',
  'Eilidh',
  'Wei',
  'Tomasz',
  'Agnieszka',
  'Kwame',
  'Fatima',
  'Hamza',
  'Niamh',
  'Callum',
  'Zara',
  'Arjun',
  'Leila',
  'Dylan',
  'Grace',
  'Yusuf',
  'Mei',
  'Ifeoma',
  'Gareth',
  'Bronwen',
  'Ravi',
  'Hannah',
  'Jamal',
  'Sofia',
  'Declan',
  'Ama',
  'Anjali',
  'Ewan',
  'Nkechi',
  'Ben',
  'Ruth',
  'Kofi',
  'Aleksandra',
  'Seren',
  'Imran',
  'Chloé',
  'Darius',
  'Margaret',
  'Harjit',
  'Tendai',
  'Róisín',
  'Ahmed',
  'Eleanor',
  'Oluwaseun',
  'Jack',
] as const

const LAST_NAMES = [
  'Smith',
  'Jones',
  'Williams',
  'Patel',
  'Khan',
  'Begum',
  'Ahmed',
  'Okafor',
  'Adeyemi',
  'Nowak',
  'Kowalski',
  'Chen',
  'Wong',
  "O'Brien",
  'Murphy',
  'MacDonald',
  'Campbell',
  'Evans',
  'Davies',
  'Hughes',
  'Singh',
  'Kaur',
  'Mensah',
  'Osei',
  'Hussain',
  'Ali',
  'Taylor',
  'Brown',
  'Wilson',
  'Ferreira',
  'Nguyen',
  'Rossi',
  'Byrne',
  'Fraser',
  'Llewellyn',
  'Thompson',
  'Robinson',
  'Clarke',
  'Mahmood',
  'Achebe',
  'Ó Súilleabháin',
  'Smith-Okafor',
  'Van der Berg',
  'Gill',
  'Chowdhury',
  'Nwosu',
  'Reid',
] as const

// Ungendered only: titles are drawn independently of first names.
const TITLES = ['', '', '', '', '', 'Dr', 'Dr', 'Mx', 'Rev', 'Prof'] as const

const NICKNAMES: Partial<Record<string, string>> = {
  Margaret: 'Peggy',
  Oluwaseun: 'Seun',
  Aleksandra: 'Ola',
  Eleanor: 'Nell',
  Mohammed: 'Mo',
}

const ORGANISATIONS = [
  "St Mary's Primary School PTA",
  'Hackney Rotary Club',
  'Patel & Sons Pharmacy',
  'Greenway Housing Co-operative',
  'The Wilson Family Foundation',
  "Bristol Rovers Supporters' Trust",
  "Leeds Grand Mosque Women's Group",
  'Kirkby Allotment Society',
  'Cardiff Bay Rowing Club',
  'Morrison Engineering Ltd',
  'Guru Nanak Gurdwara Smethwick',
  'Brixton Credit Union',
  'Hope Street Methodist Church',
  'Thames Valley Community Foundation',
  'Ludlow Women’s Institute',
  'Oakfield Bakery',
] as const

const DOMAINS = [
  'gmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'btinternet.com',
  'yahoo.co.uk',
  'icloud.com',
  'proton.me',
  'sky.com',
] as const

// Real towns, plausible postcodes: what a UK charity's records look like.
const PLACES = [
  ['Hackney', 'London', 'E8 1DY'],
  ['Brixton', 'London', 'SW9 8HE'],
  ['Clifton', 'Bristol', 'BS8 4AA'],
  ['Headingley', 'Leeds', 'LS6 3BN'],
  ['Moseley', 'Birmingham', 'B13 8JP'],
  ['Didsbury', 'Manchester', 'M20 2LN'],
  ['Leith', 'Edinburgh', 'EH6 6QU'],
  ['Partick', 'Glasgow', 'G11 5RD'],
  ['Canton', 'Cardiff', 'CF5 1JD'],
  ['Jesmond', 'Newcastle upon Tyne', 'NE2 3HE'],
  ['', 'Ludlow', 'SY8 1AZ'],
  ['Kirkby', 'Liverpool', 'L32 8RR'],
  ['', 'Belfast', 'BT7 1NN'],
  ['', 'Totnes', 'TQ9 5RY'],
  ['Smethwick', 'Sandwell', 'B66 3PQ'],
] as const

const STREETS = [
  'High Street',
  'Church Road',
  'Victoria Avenue',
  'Mill Lane',
  'Station Road',
  'Park Terrace',
  'Queens Crescent',
  'Albert Street',
  'Ffordd yr Eglwys',
  'Kingsway',
  'Elm Grove',
  'Canal Walk',
] as const

const NOTES = [
  'Prefers a phone call to email. Best after 6pm.',
  'Gift Aid declaration came in by post; scan is in the shared drive.',
  'Met at the summer fete. Keen to volunteer on the stall next year.',
  'Moving house in the spring. Check the address before any mailing.',
  'Mentioned leaving a gift in their will. Follow up gently in the autumn.',
  'Large one-off gift in memory of their mother.',
  'Asked not to be phoned at work.',
  'Large print for any letters, please.',
  'Runs the Saturday food bank rota; knows everyone.',
  'Raised £430 at the sponsored walk.',
  'Speaks Polish and English; happy to translate leaflets.',
  'Returned the last newsletter: "not known at this address".',
  'Contact via their daughter, who manages their post.',
  'Matched-giving scheme through their employer; send the form each April.',
] as const

const strip = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase()

type Draft = DonorSpec & { firstName: string; lastName: string }

/** The donors and the relationships between them. Same output on every call. */
export function generateDonors(seed = 20261017): {
  donors: Array<DonorSpec>
  relationships: Array<RelationshipSpec>
} {
  const r = rng(seed)
  const donors: Array<Draft> = []
  const relationships: Array<RelationshipSpec> = []
  let nextExternal = 1

  const key = (i: number, kind: string, n: number) =>
    `seed-${String(i).padStart(3, '0')}-${kind}${n}`

  const address = (
    i: number,
    label: 'home' | 'work',
  ): Payloads['addresses']['addresses'][number] => {
    const [line3, town, postcode] = r.pick(PLACES)
    const roll = r.next()
    const base = {
      key: key(i, 'a', 0),
      label,
      line1: `${1 + r.int(180)} ${r.pick(STREETS)}`,
      line2: r.chance(0.15) ? `Flat ${1 + r.int(12)}` : '',
      line3,
      town,
      postcode,
      country: 'GB',
      isPrimary: true,
    }
    if (roll < 0.08) return { ...base, postcode: '' } // never captured
    if (roll < 0.11)
      return { ...base, postcode: postcode.replace(' ', '') + 'X' } // typo: warns
    return base
  }

  const phone = () => {
    const d = (n: number) => Array.from({ length: n }, () => r.int(10)).join('')
    return r.pick([
      () => `07${d(3)} ${d(6)}`,
      () => `07${d(3)} ${d(6)}`,
      () => `+44 7${d(3)} ${d(6)}`,
      () => `020 ${d(4)} ${d(4)}`,
      () => `0131 ${d(3)} ${d(4)}`,
      () => `029 ${d(4)} ${d(4)}`,
    ])()
  }

  const individual = (lastName?: string): number => {
    const i = donors.length
    const firstName = r.pick(FIRST_NAMES)
    const last = lastName ?? r.pick(LAST_NAMES)
    const deceased = r.chance(0.03)
    const local = `${strip(firstName)}.${strip(last)}`
    const emails: Payloads['methods']['emails'] = []
    const roll = r.next()
    if (roll < 0.05) {
      // Malformed but storable: the contact page warns about these.
      emails.push({
        key: key(i, 'e', 0),
        label: 'home',
        address: r.chance(0.5)
          ? `${local}.${r.pick(DOMAINS)}`
          : `${local}@${r.pick(DOMAINS).split('.')[0]}`,
        isPrimary: true,
      })
    } else if (roll < 0.88) {
      emails.push({
        key: key(i, 'e', 0),
        label: 'home',
        address: `${local}${r.chance(0.3) ? r.int(99) : ''}@${r.pick(DOMAINS)}`,
        isPrimary: true,
      })
    }
    if (r.chance(0.15)) {
      emails.push({
        key: key(i, 'e', 1),
        label: 'work',
        address: `${strip(firstName)[0]}${strip(last)}@${r.pick(['nhs.net', 'council.gov.uk', 'ac.uk', 'example.co.uk'])}`,
        isPrimary: false,
      })
    }
    const phones: Payloads['methods']['phones'] = r.chance(0.6)
      ? [
          {
            key: key(i, 'p', 0),
            label: 'home',
            number: phone(),
            isPrimary: true,
          },
        ]
      : []
    const year = 1938 + r.int(68)
    donors.push({
      clientKey: `seed-donor-${String(i).padStart(3, '0')}`,
      firstName,
      lastName: last,
      details: {
        kind: 'individual',
        title: r.pick(TITLES),
        firstName,
        lastName: last,
        nickname: NICKNAMES[firstName] ?? '',
        name: '',
        birthDate: r.chance(0.4)
          ? `${year}-${String(1 + r.int(12)).padStart(2, '0')}-${String(1 + r.int(28)).padStart(2, '0')}`
          : undefined,
        isDeceased: deceased,
        deceasedDate: deceased
          ? `2025-0${1 + r.int(9)}-1${r.int(10)}`
          : undefined,
      },
      identifiers: r.chance(0.2)
        ? [
            {
              key: key(i, 'x', 0),
              type: 'External reference',
              value: `LEGACY-${String(nextExternal++).padStart(4, '0')}`,
            },
          ]
        : [],
      methods: { emails, phones },
      addresses: { addresses: r.chance(0.82) ? [address(i, 'home')] : [] },
      archived: false,
      notes: [],
    })
    return i
  }

  const organisation = (name: string): number => {
    const i = donors.length
    const local = strip(name).slice(0, 18)
    donors.push({
      clientKey: `seed-donor-${String(i).padStart(3, '0')}`,
      firstName: '',
      lastName: '',
      details: {
        kind: 'organization',
        title: '',
        firstName: '',
        lastName: '',
        nickname: '',
        name,
        isDeceased: false,
      },
      identifiers: [],
      methods: {
        emails: r.chance(0.85)
          ? [
              {
                key: key(i, 'e', 0),
                label: 'work',
                address: `${r.pick(['info', 'hello', 'treasurer', 'office'])}@${local}.org.uk`,
                isPrimary: true,
              },
            ]
          : [],
        phones: r.chance(0.7)
          ? [
              {
                key: key(i, 'p', 0),
                label: 'work',
                number: phone(),
                isPrimary: true,
              },
            ]
          : [],
      },
      addresses: {
        addresses: r.chance(0.9) ? [address(i, 'work')] : [],
      },
      archived: false,
      notes: [],
    })
    return i
  }

  // Organisations first, so individuals can work for or govern them.
  const orgs = ORGANISATIONS.map(organisation)

  // Families: 2–3 individuals sharing a surname, a home address and
  // (usually) one email, so the "also used by" warning shows. No household
  // contact while households are dormant.
  const FAMILIES = 12
  for (let h = 0; h < FAMILIES; h++) {
    const surname = LAST_NAMES[(h * 7 + 3) % LAST_NAMES.length]
    const size = 2 + r.int(2)
    const members = Array.from({ length: size }, () => individual(surname))
    const shared = `the${strip(surname)}s@${r.pick(DOMAINS)}`
    const home = address(members[0], 'home')
    for (const [n, m] of members.entries()) {
      donors[m].addresses.addresses = [{ ...home, key: key(m, 'a', 0) }]
      if (n < 2 && r.chance(0.8)) {
        const own = donors[m].methods.emails.filter((e) => e.label === 'work')
        donors[m].methods.emails = [
          {
            key: key(m, 'e', 9),
            label: 'home',
            address: shared,
            isPrimary: true,
          },
          ...own.map((e) => ({ ...e, isPrimary: false })),
        ]
      }
    }
    relationships.push({
      a: members[0],
      b: members[1],
      type: 'Spouse/partner of',
      description: '',
      startDate: `${1975 + r.int(45)}-06-${String(1 + r.int(28)).padStart(2, '0')}`,
    })
    if (size === 3) {
      relationships.push({
        a: members[0],
        b: members[2],
        type: 'Parent of',
        description: '',
      })
    }
  }

  // Everyone else: single individuals, some tied to an organisation.
  while (donors.length < DONOR_COUNT) {
    const i = individual()
    const roll = r.next()
    if (roll < 0.15) {
      relationships.push({
        a: i,
        b: r.pick(orgs),
        type: 'Employee of',
        description: r.pick([
          'Manager',
          'Volunteer coordinator',
          'Pharmacist',
          '',
        ]),
      })
    } else if (roll < 0.25) {
      relationships.push({
        a: i,
        b: r.pick(orgs),
        type: 'Trustee of',
        description: r.pick(['Chair', 'Treasurer', 'Secretary', '']),
        startDate: `20${10 + r.int(15)}-0${1 + r.int(9)}-01`,
      })
    } else if (roll < 0.35) {
      relationships.push({
        a: i,
        b: r.pick(orgs),
        type: 'Volunteer for',
        description: '',
      })
    }
  }

  // Two supporters abroad; checked like any other address, but no UK
  // postcode warning.
  const abroad = [
    {
      line1: '14 Rue des Lilas',
      line3: '',
      town: 'Lyon',
      postcode: '69003',
      country: 'FR',
    },
    {
      line1: '52 Main Street',
      line3: 'Rathmines',
      town: 'Dublin',
      postcode: 'D06 F2X8',
      country: 'IE',
    },
  ]
  for (const [n, place] of abroad.entries()) {
    const m = donors.length - 3 - n
    donors[m].addresses.addresses = [
      { ...address(m, 'home'), ...place, line2: '', postcode: place.postcode },
    ]
  }

  // Two unrelated people who share an email (a couple filed separately).
  const [p, q] = [donors.length - 1, donors.length - 2]
  const sharedCouple = `${strip(donors[p].firstName)}and${strip(donors[q].firstName)}@${r.pick(DOMAINS)}`
  for (const m of [p, q]) {
    donors[m].methods.emails = [
      {
        key: key(m, 'e', 8),
        label: 'home',
        address: sharedCouple,
        isPrimary: true,
      },
    ]
  }

  // Membership numbers: every fourth individual, in order. No random draw,
  // so the rest of the world is the same as before they were added.
  let members = 0
  donors.forEach((donor, i) => {
    if (donor.details.kind !== 'individual') return
    if (members++ % 4 !== 0) return
    donor.identifiers.push({
      key: key(i, 'x', 1),
      type: 'Membership number',
      value: `RCT-${String(members).padStart(4, '0')}`,
    })
  })

  // Archived: a handful of contacts nobody should mail any more.
  for (let n = 0; n < 7; n++) donors[r.int(DONOR_COUNT)].archived = true

  // Notes on about a third of contacts: some pinned, some archived.
  for (const donor of donors) {
    if (!r.chance(0.32)) continue
    const count = 1 + r.int(3)
    for (let n = 0; n < count; n++) {
      const archived = r.chance(0.15)
      donor.notes.push({
        body: r.pick(NOTES),
        pinned: !archived && r.chance(0.25),
        archived,
      })
    }
  }

  return {
    donors: donors.map(({ firstName: _f, lastName: _l, ...spec }) => spec),
    relationships,
  }
}
