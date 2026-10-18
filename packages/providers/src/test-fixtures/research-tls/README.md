# Research fetch TLS test fixtures

Test-only. A throwaway CA (its key was deleted after signing) and a server certificate for `research.test`, used by
`research-fetch.spec.ts` to drive the real `node:https` path against a local server on 127.0.0.1. Nothing outside the
tests trusts this CA; `server.key` protects nothing.
