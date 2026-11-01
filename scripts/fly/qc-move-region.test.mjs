// @vitest-environment node
// scripts/fly/qc-move-region.sh against mocked fly, gh and curl: it
// refuses until main says iad, moves keep-qc in the one order Fly allows
// (iad volume, then the lhr machine, then the lhr volume, then a deploy
// from main through Actions), changes nothing once moved, and never
// deploys from a working tree.
import { afterEach, beforeEach, expect, test } from 'vitest'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { sandbox } from './testing/stubs.mjs'

const SCRIPT = 'scripts/fly/qc-move-region.sh'
const MAIN_IAD = 'app = "keep-qc"\nprimary_region = "iad"\n'
const HEALTHY = { db: 'ok', commit: 'abc1234' }
let sb
beforeEach(() => {
  sb = sandbox(['fly', 'gh', 'curl', 'date'])
  sb.set('curl-answer', HEALTHY)
})
afterEach(() => sb.cleanup())

const cmds = () => sb.argv().filter(([n]) => n === 'fly' || n === 'gh')
const ran = (...prefix) =>
  cmds().some((a) => prefix.every((p, i) => a[i] === p))
// What changes anything: Fly writes and the dispatch.
const changes = () =>
  cmds()
    .filter(
      (a) =>
        (a[0] === 'fly' && ['create', 'destroy'].includes(a[2])) ||
        (a[0] === 'gh' && a[1] === 'workflow'),
    )
    .map((a) => a.slice(0, 4).join(' '))
const run = () => sb.run(SCRIPT, [], { extraEnv: { QC_MOVE_POLL: '0' } })

function inLhr() {
  sb.set('gh-main-fly-qc-toml', MAIN_IAD)
  sb.set('fly-machines.json', [{ id: 'm_lhr', region: 'lhr' }])
  sb.set('fly-volumes.json', [
    { id: 'vol_lhr', name: 'keep_data', region: 'lhr', attached_machine_id: 'm_lhr' },
  ])
}

test('qc_move_region_moves_keep_qc_in_order_volume_machine_volume_deploy', () => {
  inLhr()
  const r = run()
  expect(r.code, r.stderr).toBe(0)
  expect(changes()).toEqual([
    'fly volumes create keep_data',
    'fly machine destroy m_lhr',
    'fly volumes destroy vol_lhr',
    'gh workflow run deploy.yml',
  ])
  expect(
    ran('fly', 'volumes', 'create', 'keep_data', '-a', 'keep-qc', '--region', 'iad', '--size', '3'),
  ).toBe(true)
  expect(ran('gh', 'workflow', 'run', 'deploy.yml', '--ref', 'main', '-f', 'env=qc')).toBe(true)
  expect(ran('gh', 'run', 'watch', '4242', '--exit-status')).toBe(true)
  // The deploy put its machine on the volume made in step 1.
  expect(sb.json('fly-volumes.json')).toEqual([
    { id: 'vol_new_iad', name: 'keep_data', region: 'iad', attached_machine_id: 'm_iad' },
  ])
  expect(sb.json('fly-machines.json')).toEqual([{ id: 'm_iad', region: 'iad' }])
  expect(r.stdout).toContain('ok (commit abc1234)')
  expect(r.stdout).toContain('reseeded on every deploy')
  // Built by Actions from main: never flyctl deploy from here.
  expect(ran('fly', 'deploy')).toBe(false)
})

test('qc_move_region_already_moved_changes_nothing', () => {
  sb.set('gh-main-fly-qc-toml', MAIN_IAD)
  sb.set('fly-machines.json', [{ id: 'm_iad', region: 'iad' }])
  sb.set('fly-volumes.json', [
    { id: 'vol_iad', name: 'keep_data', region: 'iad', attached_machine_id: 'm_iad' },
  ])
  const r = run()
  expect(r.code, r.stderr).toBe(0)
  expect(changes()).toEqual([])
  expect(ran('gh', 'run')).toBe(false)
  expect(r.stdout).toContain('already in iad: nothing to move')
  expect(r.stdout).toContain('nothing changed')

  // And after a real move, a second run is the same no-op.
  inLhr()
  expect(run().code).toBe(0)
  sb.clearLogs()
  const again = run()
  expect(again.code, again.stderr).toBe(0)
  expect(changes()).toEqual([])
})

test('qc_move_region_refuses_until_mains_fly_qc_toml_says_iad', () => {
  inLhr()
  sb.set('gh-main-fly-qc-toml', 'app = "keep-qc"\nprimary_region = "lhr"\n')
  const r = run()
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('merge the change to main first')
  expect(changes()).toEqual([])
  expect(ran('fly', 'machines', 'list')).toBe(false)

  sb.set('fail-gh-contents', 'HTTP 404')
  const failed = run()
  expect(failed.code).not.toBe(0)
  expect(failed.stderr).toContain('could not read fly.qc.toml on main')
  expect(changes()).toEqual([])
})

test('qc_move_region_waits_for_deploys_and_qc_runs_in_flight', () => {
  inLhr()
  for (const wf of ['deploy.yml', 'qc.yml']) {
    sb.set('gh-runs-deploy.yml.json', [])
    sb.set('gh-runs-qc.yml.json', [])
    sb.set(`gh-runs-${wf}.json`, [
      { databaseId: 7, status: 'completed' },
      { databaseId: 9, status: 'in_progress' },
    ])
    sb.clearLogs()
    const r = run()
    expect(r.code, wf).not.toBe(0)
    expect(r.stderr).toContain(`${wf} has runs in flight (9)`)
    expect(changes()).toEqual([])
  }
})

test('qc_move_region_resumes_after_a_failure_part_way', () => {
  inLhr()
  // The lhr volume won't go (still attached, as far as Fly says).
  sb.set('fail-fly-volume-destroy', 'Error: volume is attached')
  const r = run()
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('could not destroy volume vol_lhr')
  expect(ran('gh', 'workflow')).toBe(false)

  // Fixed: the re-run makes no second iad volume, finds no lhr machine,
  // and finishes the move.
  rm('fail-fly-volume-destroy')
  sb.clearLogs()
  const again = run()
  expect(again.code, again.stderr).toBe(0)
  expect(changes()).toEqual([
    'fly volumes destroy vol_lhr',
    'gh workflow run deploy.yml',
  ])
  expect(sb.json('fly-machines.json')).toEqual([{ id: 'm_iad', region: 'iad' }])
})

test('qc_move_region_finds_the_run_when_gh_prints_no_url', () => {
  inLhr()
  sb.set('gh-dispatch-no-url', '')
  const r = run()
  expect(r.code, r.stderr).toBe(0)
  expect(ran('gh', 'run', 'watch', '4242', '--exit-status')).toBe(true)
})

test('qc_move_region_stops_when_the_deploy_run_fails', () => {
  inLhr()
  sb.set('fail-gh-run-watch', 'run failed')
  const r = run()
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('run 4242 failed')
})

test('qc_move_region_reports_an_unhealthy_keep_qc', () => {
  sb.set('gh-main-fly-qc-toml', MAIN_IAD)
  sb.set('fly-machines.json', [{ id: 'm_iad', region: 'iad' }])
  sb.set('fly-volumes.json', [
    { id: 'vol_iad', name: 'keep_data', region: 'iad', attached_machine_id: 'm_iad' },
  ])
  sb.set('curl-answer', { db: 'error' })
  // The clock jumps 200 s a call: the 150 s wait gives up after one try.
  sb.set('date-step', '200')
  const r = run()
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain("healthz isn't ok (last: {")
})

const rm = (name) => rmSync(path.join(sb.dir, 'state', name), { force: true })
