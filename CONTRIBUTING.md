# Contributing

Thanks for contributing to `mantle-agent-scaffold`.

## Before You Start

Set up the repository locally:

```bash
npm install
npm run skills:init
```

The `skills/` checkout is a pinned submodule and is part of the expected repository state.

## Development Expectations

- Keep changes scoped to the problem you are solving.
- Update the relevant README when behavior, structure, or onboarding changes.
- Add or update tests for behavior changes.
- Avoid changing unrelated files in the same pull request.

## Verification

Run these checks before opening a pull request:

```bash
npm run typecheck
npm test
```

## Pull Requests

Each pull request should include:

- a clear summary of what changed
- the reason for the change
- the verification commands you ran
- any follow-up work or known limitations

If your change affects the CLI entry point or `skills/` usage, update the relevant README or docs page in the same pull request.
