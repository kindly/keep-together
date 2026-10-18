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

/** An in-app yes / no question, open while `open`; Escape means no. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirm,
  cancel,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description: string
  confirm: string
  cancel: string
  onConfirm: () => void
  onCancel: () => void
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
        <AlertDialogFooter>
          <AlertDialogCancel>{cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
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
