from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # The route prefix is a constant referenced indirectly at the mount site,
    # so resolving it exercises the constant lookup the extractor depends on.
    API_V1_STR: str = "/api/v1"
    PROJECT_NAME: str = "miniapp"

    # No default: the extractor should mark this required.
    SECRET_KEY: str
    POSTGRES_PASSWORD: str


settings = Settings()
