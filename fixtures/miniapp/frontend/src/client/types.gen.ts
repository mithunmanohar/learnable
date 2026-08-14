// This file is auto-generated from the backend's OpenAPI document. Do not edit.

export interface NoteCreate {
  title: string
  body?: string | null
}

export interface NotePublic {
  id: string
  title: string
  body?: string | null
}

export interface NotesPublic {
  data: Array<NotePublic>
  count: number
}
