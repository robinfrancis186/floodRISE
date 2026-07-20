set shell := ["zsh", "-cu"]

install:
    pnpm install
    cd services/backend && uv sync

dev:
    pnpm dev

check:
    pnpm typecheck
    pnpm test
    pnpm build

demo-reset:
    pnpm demo:reset
