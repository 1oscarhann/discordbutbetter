process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://haunt:haunt@localhost:5432/haunt_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/15';
process.env.STORAGE_PATH ??= '/tmp/haunt-test-files';
process.env.PUBLIC_URL ??= 'http://localhost:5173';
process.env.LOG_LEVEL ??= 'silent';
