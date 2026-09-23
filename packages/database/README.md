# @ai-drama/database

M1-A only creates a PostgreSQL pool, runs `SELECT 1`, applies timeouts, and closes the pool.

This package does not open a connection when it is imported. Applications create and close the pool in their own lifecycle. It does not contain Prisma, an ORM, a schema, migrations, or domain repositories.
