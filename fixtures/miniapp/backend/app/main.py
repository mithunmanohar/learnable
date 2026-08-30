from fastapi import FastAPI

from app.api.main import api_router
from app.core.config import settings

app = FastAPI(title=settings.PROJECT_NAME)

# The full path of every route below is only knowable by following this mount
# plus the router's own prefix plus the decorator's path.
app.include_router(api_router, prefix=settings.API_V1_STR)
