from fastapi import APIRouter

from app.api.routes import notes

api_router = APIRouter()
api_router.include_router(notes.router)
