import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'

/**
 * An in-app yes / no question, open while `open`; Escape means no.
 * `children` go under the description (a reason box); `confirmDisabled`
 * holds the yes back until they're filled in.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirm,
  cancel,
  onConfirm,
  onCancel,
  children,
  confirmDisabled = false,
}: {
  open: boolean
  title: string
  description: string
  confirm: string
  cancel: string
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
  confirmDisabled?: boolean
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={confirmDisabled}
            // Not a close: the owner acts and closes it, so onCancel
            // doesn't run on the way out too.
            onClick={(e) => {
              e.preventDefault()
              onConfirm()
            }}
          >
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
