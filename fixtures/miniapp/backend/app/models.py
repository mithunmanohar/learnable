import uuid

from sqlmodel import Field, SQLModel


class NoteBase(SQLModel):
    title: str = Field(max_length=255)
    body: str | None = Field(default=None)


class NoteCreate(NoteBase):
    pass


class NotePublic(NoteBase):
    id: uuid.UUID


class Note(NoteBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    # Present on the table, deliberately absent from NotePublic — this is the
    # projection the dto-projection concept is about.
    internal_score: int = Field(default=0)


class NotesPublic(SQLModel):
    data: list[NotePublic]
    count: int
