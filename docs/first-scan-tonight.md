# First local alpha scan

This historical filename now points to the supported local-alpha workflow. Do not use old commands that copy demo `.env` files, run `prisma migrate dev`, or start app processes manually.

1. Read [friend-alpha-local.md](friend-alpha-local.md) and confirm the target is public, owned, or authorized.
2. Follow [quickstart.md](quickstart.md) to install dependencies, generate `.env.alpha`, migrate the disposable database, and start the local Compose stack.
3. Open <http://127.0.0.1:3010>, create a project, and run either the project base URL or up to 20 explicit URLs.
4. Wait for a terminal scan status. Inspect page coverage before treating results as actionable.
5. Open findings to inspect matching DOM/screenshot evidence, then use the built-in remediation references and exports.
6. Shut down only the alpha Compose project and delete `.env.alpha` when the local test is done.

This is a local single-user alpha, not a hosted service. Do not expose it to a LAN, tunnel, public host, or shared user base. Do not scan customer, internal, private, loopback, link-local, or otherwise unauthorized targets. A zero-finding scan is not a compliance certification.
