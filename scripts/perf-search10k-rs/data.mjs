// Deterministic, realistic-looking UK contacts for the 10k search
// measurement (factory task perf/search-10k). Pure: no Convex imports.

/** mulberry32: a small seeded PRNG, so every run builds the same people. */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (r, xs) => xs[Math.floor(r() * xs.length)]

/** Index into `weights` (any positive numbers), by weight. */
function weighted(r, weights) {
  const total = weights.reduce((a, b) => a + b, 0)
  let x = r() * total
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i]
    if (x < 0) return i
  }
  return weights.length - 1
}

// Top UK surnames after Smith and Jones, roughly in frequency order.
const COMMON_SURNAMES =
  `Williams Taylor Brown Davies Evans Wilson Thomas Johnson
Roberts Robinson Thompson Wright Walker White Edwards Hughes Green Hall Lewis
Harris Clarke Patel Jackson Wood Turner Martin Cooper Hill Ward Morris Moore
Clark Lee King Baker Harrison Morgan Allen James Scott Phillips Watson Davis
Parker Price Bennett Young Griffiths Mitchell Kelly Cook Carter Richardson
Bailey Collins Bell Shaw Murphy Miller Cox Richards Khan Marshall Anderson
Simpson Ellis Adams Singh Begum Wilkinson Foster Chapman Powell Webb Rogers
Gray Mason Ali Hunt Hussain Campbell Matthews Owen Palmer Holmes Mills Barnes
Knight Lloyd Butler Russell Barker Fisher Stevens Jenkins Murray Dixon Harvey
O'Brien Smith-Jones McDonald Graham Reid Kaur Ahmed Rahman Nowak`.split(/\s+/)

// Long-tail surnames: two syllables each, a few thousand distinct.
const HEADS = `Ash Brad Black Brook Cart Chad Dun Fair Ford Gold Green Hal Hart
Hay Holt Kent Lang Mars Mid New Nor Oak Pen Rad Ram Red Rook Rus Sal Shel
Stan Sut Thorn Wain Wal Wex Whit Win Wol Wood Yar Alder Bel Cal Craw Dal Ead
Fen Gar Hol Kin Lind Mel Prest Sand Stock Tal Ux Ven`.split(/\s+/)
const TAILS = `worth shaw ley ton field ham wood well by more bridge stone wick
ford dale hurst combe croft land wright man son er ings cott leigh row ridge
gate burn den low`.split(/\s+/)

const FEMALE = `Olivia Amelia Isla Ava Mia Ivy Lily Isabella Sophia Grace
Emily Poppy Ella Freya Charlotte Evie Florence Alice Sienna Willow Sarah Emma
Claire Helen Rachel Laura Nicola Rebecca Joanne Louise Susan Margaret Patricia
Jean Ann Elizabeth Mary Karen Julie Lisa Michelle Jennifer Hannah Amy Jessica
Lucy Chloe Fatima Aisha Priya Siobhan Niamh Megan Bethan Zoe`.split(/\s+/)
const MALE = `Oliver George Noah Arthur Leo Muhammad Harry Oscar Archie Henry
Jack Charlie Freddie Theo Thomas James William Jacob David John Michael Paul
Andrew Mark Richard Peter Robert Christopher Stephen Daniel Matthew Simon
Anthony Ian Gary Kevin Alan Brian Martin Neil Graham Colin Keith Mohammed Ravi
Aidan Sean Callum Dylan Rhys Owen Liam Ryan Adam Luke Samuel Joseph`.split(
  /\s+/,
)

const DOMAINS = [
  ['gmail.com', 38],
  ['hotmail.co.uk', 14],
  ['yahoo.co.uk', 9],
  ['outlook.com', 8],
  ['btinternet.com', 8],
  ['icloud.com', 6],
  ['sky.com', 4],
  ['live.co.uk', 4],
  ['aol.com', 2],
]

// Postcode districts with a town and streets: the first few are dense
// clusters (a group's home patch), the rest scattered.
const AREAS = [
  [
    'LS6',
    'Leeds',
    800,
    [
      'Hyde Park Road',
      'Headingley Lane',
      'Cardigan Road',
      'Brudenell Road',
      'Victoria Road',
      'Kirkstall Lane',
      'Ash Road',
      'Otley Road',
    ],
  ],
  [
    'LS7',
    'Leeds',
    400,
    [
      'Chapeltown Road',
      'Harehills Avenue',
      'Potternewton Lane',
      'Scott Hall Road',
    ],
  ],
  [
    'LS8',
    'Leeds',
    300,
    ['Roundhay Road', 'Easterly Road', 'Oakwood Lane', 'Gledhow Valley Road'],
  ],
  [
    'M14',
    'Manchester',
    450,
    ['Wilmslow Road', 'Platt Lane', 'Mauldeth Road', 'Ladybarn Lane'],
  ],
  [
    'M20',
    'Manchester',
    350,
    ['Burton Road', 'Lapwing Lane', 'Palatine Road', 'School Lane'],
  ],
  [
    'BS6',
    'Bristol',
    400,
    ['Gloucester Road', 'Cotham Hill', 'Chandos Road', 'Cranbrook Road'],
  ],
  ['BS7', 'Bristol', 250, ['Muller Road', 'Ashley Down Road', 'Filton Avenue']],
  [
    'E17',
    'London',
    350,
    ['Hoe Street', 'Forest Road', 'Blackhorse Lane', 'Orford Road'],
  ],
  [
    'SW11',
    'London',
    250,
    ['Lavender Hill', 'Northcote Road', 'Battersea Rise'],
  ],
  [
    'N16',
    'London',
    200,
    ['Stoke Newington Church Street', 'Albion Road', 'Allen Road'],
  ],
  ['CF24', 'Cardiff', 200, ['City Road', 'Richmond Road', 'Crwys Road']],
  [
    'EH6',
    'Edinburgh',
    150,
    ['Leith Walk', 'Great Junction Street', 'Easter Road'],
  ],
  [
    'G12',
    'Glasgow',
    150,
    ['Byres Road', 'Great Western Road', 'Highburgh Road'],
  ],
  ['YO10', 'York', 150, ['Heslington Road', 'Lawrence Street', 'Hull Road']],
  [
    'NG7',
    'Nottingham',
    150,
    ['Derby Road', 'Lenton Boulevard', 'Ilkeston Road'],
  ],
]
// Scattered districts take what the clusters leave.
const SCATTER = `B13 B29 S10 S11 L15 L17 NE6 OX4 CB1 BN1 BN2 PL4 EX4 LE2 CV5
DE22 HU5 SO17 PO5 RG1 NR2 BA2 GL1 TR1 AB10 DD1 BT9 SA1 LL57 IP4`.split(/\s+/)
const SCATTER_TOWN =
  'Birmingham Birmingham Sheffield Sheffield Liverpool Liverpool Newcastle Oxford Cambridge Brighton Brighton Plymouth Exeter Leicester Coventry Derby Hull Southampton Portsmouth Reading Norwich Bath Gloucester Truro Aberdeen Dundee Belfast Swansea Bangor Ipswich'.split(
    ' ',
  )
const SCATTER_STREETS = [
  'High Street',
  'Church Lane',
  'Station Road',
  'Park Avenue',
  'Mill Lane',
  'Victoria Street',
  'Queens Road',
  'The Green',
]

const LETTERS = 'ABDEFGHJLNPQRSTUWXYZ'

/** An inward code: a digit and two letters (no C I K M O V). */
function inward(r) {
  return `${Math.floor(r() * 10)}${pick(r, LETTERS)}${pick(r, LETTERS)}`
}

const ORG_WORDS = `Community Allotment Youth Arts Heritage Wildlife Food Bank
Tenants Cycling Choir Library Friends Gardening Football Cricket Theatre
Repair Café Refugee Support Women's Network Men's Shed Carers`.split(/\s+/)
const ORG_SUFFIX = [
  'Trust',
  'Group',
  'Association',
  'Society',
  'Club',
  'Project',
  'Ltd',
  'CIC',
  'Foundation',
]

/**
 * `count` people for the big tenant. Smith × 300 and Jones × 100 exactly;
 * kinds ~92/6/2 %; emails on ~85 %, phones on ~50 %, addresses on ~85 %.
 */
export function people(count, seed = 1) {
  const r = rng(seed)
  // Surname slots: exact Smith/Jones counts, the rest Zipf over the
  // common list (~45 %) or the long tail.
  const surnames = []
  for (let i = 0; i < 300; i++) surnames.push('Smith')
  for (let i = 0; i < 100; i++) surnames.push('Jones')
  const zipf = COMMON_SURNAMES.map((_, i) => 1 / (i + 4))
  while (surnames.length < count) {
    surnames.push(
      r() < 0.45
        ? COMMON_SURNAMES[weighted(r, zipf)]
        : `${pick(r, HEADS)}${pick(r, TAILS)}`,
    )
  }
  // Shuffle so Smiths are spread through creation order.
  for (let i = surnames.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[surnames[i], surnames[j]] = [surnames[j], surnames[i]]
  }
  const fz = (xs) => xs.map((_, i) => 1 / (i + 2))
  const fw = fz(FEMALE)
  const mw = fz(MALE)
  // Area slots, clusters first.
  const areaSlots = []
  for (const [district, town, n, streets] of AREAS) {
    // A cluster's full postcodes repeat (a street holds several donors).
    const codes = Array.from({ length: Math.ceil(n / 12) }, () => inward(r))
    for (let i = 0; i < n; i++)
      areaSlots.push({ district, town, streets, inward: pick(r, codes) })
  }
  const seen = new Map()
  const out = []
  for (let i = 0; i < count; i++) {
    const k = r()
    const kind =
      k < 0.92 ? 'individual' : k < 0.98 ? 'organization' : 'household'
    const female = r() < 0.52
    const firstName =
      kind === 'individual'
        ? female
          ? FEMALE[weighted(r, fw)]
          : MALE[weighted(r, mw)]
        : ''
    const lastName = kind === 'individual' ? surnames[i] : ''
    const name =
      kind === 'organization'
        ? `${pick(r, AREAS)[1]} ${pick(r, ORG_WORDS)} ${pick(r, ORG_SUFFIX)}`
        : kind === 'household'
          ? `The ${surnames[i]} Household`
          : ''
    const base = (
      kind === 'individual'
        ? `${firstName}.${lastName}`
        : name.split(' ').slice(0, 2).join('')
    )
      .toLowerCase()
      .replace(/[^a-z.]/g, '')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    const emails =
      r() < 0.85
        ? [
            {
              label: kind === 'individual' ? 'home' : 'work',
              address: `${base}${n > 1 ? n : ''}@${
                DOMAINS[
                  weighted(
                    r,
                    DOMAINS.map((d) => d[1]),
                  )
                ][0]
              }`,
              isPrimary: true,
            },
          ]
        : []
    const phones =
      r() < 0.5
        ? [
            {
              label: r() < 0.7 ? 'home' : 'work',
              number:
                r() < 0.7
                  ? `07${700 + Math.floor(r() * 300)} ${String(Math.floor(r() * 1e6)).padStart(6, '0')}`
                  : `0113 ${String(Math.floor(r() * 1e3)).padStart(3, '0')} ${String(Math.floor(r() * 1e4)).padStart(4, '0')}`,
              isPrimary: true,
            },
          ]
        : []
    let addresses = []
    if (r() < 0.85) {
      const slot =
        areaSlots.length && r() < 0.82
          ? areaSlots.splice(Math.floor(r() * areaSlots.length), 1)[0]
          : (() => {
              const j = Math.floor(r() * SCATTER.length)
              return {
                district: SCATTER[j],
                town: SCATTER_TOWN[j],
                streets: SCATTER_STREETS,
                inward: inward(r),
              }
            })()
      addresses = [
        {
          label: kind === 'individual' ? 'home' : 'work',
          line1: `${1 + Math.floor(r() * 180)} ${pick(r, slot.streets)}`,
          line2: '',
          line3: '',
          town: slot.town,
          postcode: `${slot.district} ${slot.inward}`,
          country: 'GB',
          isPrimary: true,
        },
      ]
    }
    out.push({
      details: {
        kind,
        title: '',
        firstName,
        lastName,
        nickname: '',
        name,
        isDeceased: false,
      },
      emails,
      phones,
      addresses,
      // 0..2: which option of the tenant's field, or null; ~30 % set.
      option: r() < 0.3 ? weighted(r, [5, 3, 2]) : null,
      // ~40 % coded: index into the tenant's versions.
      code: r() < 0.4 ? Math.floor(r() * 4) : null,
      archived: r() < 0.05,
    })
  }
  return out
}
