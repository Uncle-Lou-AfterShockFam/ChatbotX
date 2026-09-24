import { toast } from "sonner"

/** next-safe-action onError: surface the server message as a toast. */
export const onActionError = ({
  error,
}: {
  error: { serverError?: string }
}) => {
  if (error.serverError) {
    toast.error(error.serverError)
  }
}
