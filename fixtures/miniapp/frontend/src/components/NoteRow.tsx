import type { NotePublic } from "@/client/types.gen"

export default function NoteRow({ note }: { note: NotePublic }) {
  return (
    <div>
      <strong>{note.title}</strong>
      <p>{note.body}</p>
    </div>
  )
}
