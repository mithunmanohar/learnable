# miniapp — extractor test fixture

A deliberately small full-stack app used by the extractor's tests. It is not
meant to run; it exists to exercise the extraction paths that are easy to get
wrong and expensive to debug against a large repository:

- a route whose real path (`/api/v1/notes/`) is spread across three files and a
  settings constant, reachable only by following the `include_router` chain
- a persisted model (`Note`) alongside non-persisted shapes (`NoteCreate`,
  `NotePublic`) that share a base, including a column (`internal_score`) that
  the public shape deliberately omits
- an ORM write issued against a local variable (`session.add(note)`) rather than
  the model class, which is how real handlers are written
- a generated client whose URL literals must be matched back to those routes
- a compose file declaring the database the persisted model maps onto

Changing these files will change the extractor's test expectations.
