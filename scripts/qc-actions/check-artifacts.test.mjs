// @vitest-environment node
// scripts/qc-actions/check-artifacts.mjs: the token, however it's written
// and wherever it hides (a trace's zip, the HTML report's base64 data, a
// gzip, a file name), stops the upload; anything it can't open stops it
// too. Run as the workflow runs it: token in the env, never an argument.
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { check, needles, redact, unzip } from './check-artifacts.mjs'
import { zip } from './testing/zip.mjs'

const SCRIPT = path.join(import.meta.dirname, 'check-artifacts.mjs')
// The shape scripts/fly/qc.sh makes: 32 random bytes, hex.
const TOKEN = '3f9a1c0e7b2d4f6a8c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a'

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'check-artifacts-'))
  mkdirSync(path.join(dir, 'qc-results', 'runs', 'r1'), { recursive: true })
  mkdirSync(path.join(dir, 'qc-report', 'playwright', 'data'), {
    recursive: true,
  })
  // A clean run's output.
  writeFileSync(
    path.join(dir, 'qc-results', 'history.jsonl'),
    '{"runId":"r1","flow":"contact.save","samplesMs":[80]}\n',
  )
  writeFileSync(
    path.join(dir, 'qc-report', 'playwright', 'data', 'trace.zip'),
    zip([
      ['trace.trace', '{"type":"before","apiName":"page.goto"}\n'],
      ['resources/x.html', '<html>a page</html>'],
    ]),
  )
  writeFileSync(
    path.join(dir, 'qc-report', 'playwright', 'index.html'),
    `<html><script id="playwrightReportBase64" type="application/zip">data:application/zip;base64,${zip([['report.json', '{"files":[]}']]).toString('base64')}</script></html>`,
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const at = (...p) => path.join(dir, ...p)
const both = () => [at('qc-results'), at('qc-report')]

function run(env) {
  const r = spawnSync(process.execPath, [SCRIPT, 'qc-results', 'qc-report'], {
    cwd: dir,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('check', () => {
  test('a clean run: nothing found, exit 0', () => {
    expect(check(both(), TOKEN)).toEqual([])
    const r = run({ KEEP_QC_TOKEN: TOKEN })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/3 files, no token in any/)
  })

  test('the token as it is, in any case, as JSON and URL would write it', () => {
    for (const written of [
      TOKEN,
      TOKEN.toUpperCase(),
      `"x-keep-qc-token":"${TOKEN}"`,
      `?t=${encodeURIComponent(TOKEN)}`,
    ]) {
      writeFileSync(at('qc-results', 'runs', 'r1', 'pid-1.jsonl'), written)
      expect(check(both(), TOKEN)).toEqual([
        at('qc-results', 'runs', 'r1', 'pid-1.jsonl'),
      ])
    }
  })

  test('base64, at each alignment, standard and URL-safe', () => {
    for (const pad of ['', 'a', 'ab', 'abc']) {
      for (const enc of ['base64', 'base64url']) {
        writeFileSync(
          at('qc-results', 'blob.txt'),
          Buffer.from(`${pad}${TOKEN}tail`).toString(enc),
        )
        expect(check(both(), TOKEN), `${pad.length} ${enc}`).toHaveLength(1)
      }
    }
  })

  test('inside a trace: a zip entry, deflated or stored, zip64 too', () => {
    for (const opts of [{}, { store: true }, { zip64: true }]) {
      writeFileSync(
        at('qc-report', 'playwright', 'data', 'trace.zip'),
        zip(
          [
            ['trace.trace', '{}'],
            [
              'trace.network',
              `{"headers":[{"name":"x-keep-qc-token","value":"${TOKEN}"}]}`,
            ],
          ],
          opts,
        ),
      )
      // A stored entry is in the zip's own bytes too; a deflated one only
      // inside.
      expect(check(both(), TOKEN), JSON.stringify(opts)).toContain(
        `${at('qc-report', 'playwright', 'data', 'trace.zip')}!trace.network`,
      )
    }
  })

  test('inside the HTML report: its base64 zip, and a zip in that', () => {
    const inner = zip([['trace.network', TOKEN]])
    writeFileSync(
      at('qc-report', 'playwright', 'index.html'),
      `<script>data:application/zip;base64,${zip([
        ['report.json', '{}'],
        ['data/t.zip', inner],
      ]).toString('base64')}</script>`,
    )
    expect(check(both(), TOKEN)).toEqual([
      `${at('qc-report', 'playwright', 'index.html')}#data-url-0!data/t.zip!trace.network`,
    ])
  })

  test('inside a gzip, and in a file or entry name', () => {
    writeFileSync(at('qc-results', 'log.gz'), gzipSync(`token ${TOKEN}`))
    writeFileSync(at('qc-results', `x-${TOKEN}.txt`), 'nothing')
    writeFileSync(
      at('qc-report', 'n.zip'),
      zip([[`attachments/${TOKEN}.txt`, 'nothing']]),
    )
    expect(check(both(), TOKEN).sort()).toEqual(
      [
        `${at('qc-results', 'log.gz')}!gunzip`,
        `${at('qc-results', `x-${TOKEN}.txt`)} (name)`,
        // Entry names are stored as they are: the zip's bytes hold it too.
        at('qc-report', 'n.zip'),
        `${at('qc-report', 'n.zip')}!attachments/${TOKEN}.txt (name)`,
      ].sort(),
    )
  })

  test('hidden files are checked too', () => {
    writeFileSync(at('qc-results', '.instances.json'), TOKEN)
    expect(check(both(), TOKEN)).toHaveLength(1)
  })
})

describe('fails closed', () => {
  test('a hit: exit 1, the places named, the token never printed', () => {
    writeFileSync(at('qc-results', `x-${TOKEN}.txt`), TOKEN)
    const r = run({ KEEP_QC_TOKEN: TOKEN })
    expect(r.code).toBe(1)
    expect(r.out).toContain("::error::KEEP_QC_TOKEN's value is in 2 place(s)")
    expect(r.out).toContain('x-[KEEP_QC_TOKEN].txt')
    expect(r.out.toLowerCase()).not.toContain(TOKEN)
  })

  test('no token, or one too short to mean anything: exit 2', () => {
    for (const env of [{}, { KEEP_QC_TOKEN: '' }, { KEEP_QC_TOKEN: 'short' }]) {
      const r = run(env)
      expect(r.code).toBe(2)
      expect(r.out).toMatch(
        /could not check everything: KEEP_QC_TOKEN is unset or shorter/,
      )
    }
    expect(() => needles('x'.repeat(15))).toThrow()
  })

  test('what it can’t open: a broken zip, an encrypted or unknown entry, a symlink, a missing path', () => {
    const bad = [
      () =>
        writeFileSync(
          at('qc-report', 'b.zip'),
          Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(40)]),
        ),
      () => {
        const z = zip([['a', 'b']], { store: true })
        z.writeUInt16LE(1, 6) // encrypted, in the local header …
        z.writeUInt16LE(1, z.length - 22 - 46 - 1 + 8) // … and the central one
        writeFileSync(at('qc-report', 'e.zip'), z)
      },
      () => {
        const z = zip([['a', 'b']], { store: true })
        z.writeUInt16LE(12, z.length - 22 - 46 - 1 + 10) // bzip2
        writeFileSync(at('qc-report', 'm.zip'), z)
      },
      () =>
        writeFileSync(
          at('qc-report', 'g.gz'),
          Buffer.from([0x1f, 0x8b, 1, 2, 3]),
        ),
      () => symlinkSync('/etc/hostname', at('qc-results', 'link')),
    ]
    for (const make of bad) {
      rmSync(at('qc-report'), { recursive: true, force: true })
      rmSync(at('qc-results', 'link'), { force: true })
      mkdirSync(at('qc-report'))
      make()
      const r = run({ KEEP_QC_TOKEN: TOKEN })
      expect(r.code, make.toString()).toBe(2)
      expect(r.out).toContain('Nothing will be uploaded')
    }
    rmSync(at('qc-report'), { recursive: true, force: true })
    expect(run({ KEEP_QC_TOKEN: TOKEN }).code).toBe(2)
  })

  test('the token on its own is never an argument it takes', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(r.status).toBe(2)
  })
})

test('unzip reads what it wrote; redact blanks the token in any case', () => {
  expect(
    unzip(
      zip([
        ['a.txt', 'one'],
        ['b/c.txt', 'two'],
      ]),
    ).map(([n, b]) => [n, b.toString()]),
  ).toEqual([
    ['a.txt', 'one'],
    ['b/c.txt', 'two'],
  ])
  expect(redact(`a ${TOKEN.toUpperCase()} b`, TOKEN)).toBe(
    'a [KEEP_QC_TOKEN] b',
  )
})
