// This file is auto-generated from the backend's OpenAPI document. Do not edit.
import { client } from "./client.gen"
import type { NoteCreate, NotePublic, NotesPublic } from "./types.gen"

export class NotesService {
  /**
   * Read Notes
   */
  public static readNotes(options?: { query?: { limit?: number } }) {
    return client.get<NotesPublic>({
      url: "/api/v1/notes/",
      ...options,
    })
  }

  /**
   * Create Note
   */
  public static createNote(options: { body: NoteCreate }) {
    return client.post<NotePublic>({
      url: "/api/v1/notes/",
      ...options,
    })
  }

  /**
   * Delete Note
   */
  public static deleteNote(options: { path: { id: string } }) {
    return client.delete<void>({
      url: "/api/v1/notes/{id}",
      ...options,
    })
  }
}
