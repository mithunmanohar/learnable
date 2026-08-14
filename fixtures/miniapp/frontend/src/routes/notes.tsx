import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"

import { NotesService } from "@/client/sdk.gen"
import NoteRow from "@/components/NoteRow"

export const Route = createFileRoute("/notes")({ component: NotesPage })

function NotesPage() {
  const { data } = useSuspenseQuery({
    queryKey: ["notes"],
    queryFn: async () => (await NotesService.readNotes({ query: { limit: 100 } })).data,
  })

  return (
    <div>
      <AddNote />
      {data.data.map((note) => (
        <NoteRow key={note.id} note={note} />
      ))}
    </div>
  )
}

function AddNote() {
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (title: string) => NotesService.createNote({ body: { title } }),
    // Without this the list above keeps serving its cached copy.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes"] }),
  })

  return <button onClick={() => mutation.mutate("new note")}>Add</button>
}
