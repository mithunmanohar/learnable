import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import func, select

from app.api.deps import CurrentUser, SessionDep
from app.models import Note, NoteCreate, NotePublic, NotesPublic

router = APIRouter(prefix="/notes", tags=["notes"])


@router.get("/", response_model=NotesPublic)
def read_notes(session: SessionDep, current_user: CurrentUser, limit: int = 100) -> Any:
    """
    Retrieve notes.
    """
    count = session.exec(select(func.count()).select_from(Note)).one()
    notes = session.exec(select(Note).limit(limit)).all()
    return NotesPublic(data=notes, count=count)


@router.post("/", response_model=NotePublic)
def create_note(*, session: SessionDep, current_user: CurrentUser, note_in: NoteCreate) -> Any:
    """
    Create a new note.
    """
    note = Note.model_validate(note_in)
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@router.delete("/{id}")
def delete_note(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """
    Delete a note.
    """
    note = session.get(Note, id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    session.delete(note)
    session.commit()
    return {"ok": True}
