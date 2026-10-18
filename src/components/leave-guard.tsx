import { useCallback } from 'react'
import { useBlocker } from '@tanstack/react-router'
import type { UnsavedWork } from '../lib/unsaved'
import { ConfirmDialog } from './confirm-dialog'

/** How long leaving waits for saves already under way to land. */
const SETTLE_MS = 5000

/**
 * Asks before the page is left with work not on the server. Inside the
 * SPA, leaving is first treated as leaving the focused field: its blur
 * saves what it would save anyway (a link click has already done this;
 * the back button hasn't). Saves under way or queued are then started
 * and waited for, so only what is still unsaved after that asks: text a
 * blur won't save (empty, over the cap, in conflict) or a refused save.
 * Closing or reloading the tab can't wait: anything not clean gets the
 * browser's own prompt.
 */
export function LeaveGuard({ work }: { work: UnsavedWork }) {
  const shouldBlockFn = useCallback(async () => {
    if (work.state() === 'clean') return false
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
      // Let the blur's state updates commit and report in.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    work.flush()
    return (await work.settled(SETTLE_MS)) !== 'clean'
  }, [work])
  const enableBeforeUnload = useCallback(() => work.state() !== 'clean', [work])
  const blocker = useBlocker({
    shouldBlockFn,
    enableBeforeUnload,
    withResolver: true,
  })
  return (
    <ConfirmDialog
      open={blocker.status === 'blocked'}
      title="You have unsaved changes: leave anyway?"
      description="Changes on this page that haven't been saved will be lost."
      confirm="Leave anyway"
      cancel="Stay"
      onConfirm={() => blocker.proceed?.()}
      onCancel={() => blocker.reset?.()}
    />
  )
}
