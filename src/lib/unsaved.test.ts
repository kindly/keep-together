import { describe, expect, test } from 'vitest'
import { UnsavedWork, worst } from './unsaved'

describe('worst', () => {
  test('unsaved over busy over clean', () => {
    expect(worst([])).toBe('clean')
    expect(worst(['clean', 'busy', 'clean'])).toBe('busy')
    expect(worst(['busy', 'unsaved', 'clean'])).toBe('unsaved')
  })
})

describe('UnsavedWork', () => {
  test('reads the worst entry; a removed entry no longer counts', () => {
    const w = new UnsavedWork()
    w.set('form', { state: 'clean' })
    w.set('note', { state: 'unsaved' })
    expect(w.state()).toBe('unsaved')
    w.delete('note')
    expect(w.state()).toBe('clean')
  })

  test('flush asks every entry to start its queued save', () => {
    const w = new UnsavedWork()
    const calls: Array<string> = []
    w.set('a', { state: 'busy', flush: () => calls.push('a') })
    w.set('b', { state: 'clean' })
    w.flush()
    expect(calls).toEqual(['a'])
  })

  test('settled waits for busy entries, then reports what is left', async () => {
    const w = new UnsavedWork()
    w.set('a', { state: 'busy' })
    const done = w.settled(1000)
    w.set('a', { state: 'unsaved' })
    expect(await done).toBe('unsaved')
    w.set('a', { state: 'clean' })
    expect(await w.settled(1000)).toBe('clean')
  })

  test('settled gives up after the timeout, still busy', async () => {
    const w = new UnsavedWork()
    w.set('a', { state: 'busy' })
    expect(await w.settled(5)).toBe('busy')
  })
})
