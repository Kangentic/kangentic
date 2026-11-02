// One executable resource and the dashboard, for tests/unit/aspire-host-death.test.ts.
// No containers: the shape of the process tree is the question, and the reap only sees processes.
var builder = DistributedApplication.CreateBuilder(args);

builder.AddExecutable("worker", "ping", ".", "-n", "3600", "127.0.0.1");

builder.Build().Run();
