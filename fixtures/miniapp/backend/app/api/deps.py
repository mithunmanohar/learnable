from typing import Annotated

from fastapi import Depends
from sqlmodel import Session

from app.models import Note


def get_session() -> Session:
    raise NotImplementedError("fixture only")


def get_current_user() -> Note:
    raise NotImplementedError("fixture only")


SessionDep = Annotated[Session, Depends(get_session)]
CurrentUser = Annotated[Note, Depends(get_current_user)]
