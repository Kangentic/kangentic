/**
 * The open-failure notifier in src/main/db/database.ts. Every failed open of the
 * global or a project database tells the injected notifier which database and
 * which stage failed (`open`, `pragma`, `migrate`, `initialize`), then rethrows
 * the SAME error. The half-built handle is closed, nothing is cached, and a
 * notifier that itself throws never replaces the original error.
 *
 * `better-sqlite3` is mocked, as in global-db-degradation.test.ts, so a test can
 * make the driver throw at a chosen step. Module state (the caches and the
 * notifier) is cleared with vi.resetModules() and a fresh import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { openDatabase, runGlobalMigrationsMock, runProjectMigrationsMock } = vi.hoisted(() => ({
  openDatabase: vi.fn(),
  runGlobalMigrationsMock: vi.fn(),
  runProjectMigrationsMock: vi.fn(),
}));

vi.mock('better-sqlite3', () => ({
  default: function MockDatabase(file: string, options?: unknown) {
    return openDatabase(file, options);
  },
}));

vi.mock('../../src/main/db/migrations', () => ({
  runGlobalMigrations: (...callArguments: unknown[]) => runGlobalMigrationsMock(...callArguments),
  runProjectMigrations: (...callArguments: unknown[]) => runProjectMigrationsMock(...callArguments),
}));

vi.mock('../../src/main/config/paths', () => ({
  PATHS: {
    globalDb: '/mock/config/index.db',
    projectDb: (id: string) => `/mock/config/projects/${id}.db`,
  },
  ensureDirs: vi.fn(),
}));

interface MockConnection {
  pragma: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function healthyConnection(): MockConnection {
  return { pragma: vi.fn(), close: vi.fn() };
}

/** A connection whose first pragma throws `error`. */
function connectionFailingPragma(error: Error): MockConnection {
  return { pragma: vi.fn(() => { throw error; }), close: vi.fn() };
}

async function freshDatabaseModule() {
  vi.resetModules();
  return import('../../src/main/db/database');
}

beforeEach(() => {
  openDatabase.mockReset();
  runGlobalMigrationsMock.mockReset();
  runProjectMigrationsMock.mockReset();
});

describe('db open failure notifier', () => {
  it('global: a constructor that throws notifies stage "open" and rethrows the same error', async () => {
    const openError = new Error('unable to open database file');
    openDatabase.mockImplementationOnce(() => { throw openError; });
    const { getGlobalDb, setDbOpenFailureNotifier } = await freshDatabaseModule();
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);

    let thrown: unknown;
    try { getGlobalDb(); } catch (error) { thrown = error; }

    expect(thrown).toBe(openError);
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith(openError, { database: 'global', stage: 'open' });
  });

  it('project: a database that must exist but does not notifies stage "open"', async () => {
    const missing = Object.assign(new Error('Cannot open database because the directory does not exist'), { code: 'SQLITE_CANTOPEN' });
    openDatabase.mockImplementationOnce(() => { throw missing; });
    const { getProjectDb, configureProjectDbAccess, setDbOpenFailureNotifier } = await freshDatabaseModule();
    configureProjectDbAccess({ projectsDir: '/mock/projects', migrate: false });
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);

    expect(() => getProjectDb('gone')).toThrow(missing);

    expect(openDatabase).toHaveBeenCalledWith(expect.stringContaining('gone.db'), { fileMustExist: true });
    expect(notifier).toHaveBeenCalledWith(missing, { database: 'project', stage: 'open' });
  });

  it('global: a pragma failure notifies stage "pragma", closes the handle and does not cache', async () => {
    const pragmaError = new Error('disk I/O error');
    const broken = connectionFailingPragma(pragmaError);
    const healthy = healthyConnection();
    openDatabase.mockReturnValueOnce(broken).mockReturnValueOnce(healthy);
    const { getGlobalDb, setDbOpenFailureNotifier } = await freshDatabaseModule();
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);

    let thrown: unknown;
    try { getGlobalDb(); } catch (error) { thrown = error; }

    expect(thrown).toBe(pragmaError);
    expect(notifier).toHaveBeenCalledWith(pragmaError, { database: 'global', stage: 'pragma' });
    expect(broken.close).toHaveBeenCalledTimes(1);
    expect(getGlobalDb()).toBe(healthy);
    expect(openDatabase).toHaveBeenCalledTimes(2);
  });

  it('global: a migration failure notifies stage "migrate"', async () => {
    const migrationError = new Error('migration failed');
    const broken = healthyConnection();
    openDatabase.mockReturnValueOnce(broken);
    runGlobalMigrationsMock.mockImplementationOnce(() => { throw migrationError; });
    const { getGlobalDb, setDbOpenFailureNotifier } = await freshDatabaseModule();
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);

    expect(() => getGlobalDb()).toThrow(migrationError);

    expect(notifier).toHaveBeenCalledWith(migrationError, { database: 'global', stage: 'migrate' });
    expect(broken.close).toHaveBeenCalledTimes(1);
  });

  it('project: a pragma failure notifies stage "pragma", closes the handle and caches nothing', async () => {
    const pragmaError = new Error('disk I/O error');
    const broken = connectionFailingPragma(pragmaError);
    const healthy = healthyConnection();
    openDatabase.mockReturnValueOnce(broken).mockReturnValueOnce(healthy);
    const { getProjectDb, setDbOpenFailureNotifier } = await freshDatabaseModule();
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);

    expect(() => getProjectDb('project-1')).toThrow(pragmaError);

    expect(notifier).toHaveBeenCalledWith(pragmaError, { database: 'project', stage: 'pragma' });
    expect(broken.close).toHaveBeenCalledTimes(1);
    expect(getProjectDb('project-1')).toBe(healthy);
  });

  it('project: a migration failure notifies stage "migrate"', async () => {
    const migrationError = new Error('migration failed');
    const broken = healthyConnection();
    openDatabase.mockReturnValueOnce(broken);
    runProjectMigrationsMock.mockImplementationOnce(() => { throw migrationError; });
    const { getProjectDb, setDbOpenFailureNotifier } = await freshDatabaseModule();
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);

    expect(() => getProjectDb('project-1')).toThrow(migrationError);

    expect(notifier).toHaveBeenCalledWith(migrationError, { database: 'project', stage: 'migrate' });
    expect(broken.close).toHaveBeenCalledTimes(1);
  });

  it('project: a throwing initializer notifies stage "initialize", closes the handle and caches nothing', async () => {
    const initializerError = new Error('vec extension failed');
    const broken = healthyConnection();
    const healthy = healthyConnection();
    openDatabase.mockReturnValueOnce(broken).mockReturnValueOnce(healthy);
    const { getProjectDb, setProjectDbInitializer, setDbOpenFailureNotifier } = await freshDatabaseModule();
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);
    setProjectDbInitializer(() => { throw initializerError; });

    let thrown: unknown;
    try { getProjectDb('project-1'); } catch (error) { thrown = error; }

    expect(thrown).toBe(initializerError);
    expect(notifier).toHaveBeenCalledWith(initializerError, { database: 'project', stage: 'initialize' });
    expect(broken.close).toHaveBeenCalledTimes(1);

    setProjectDbInitializer(() => {});
    expect(getProjectDb('project-1')).toBe(healthy);
  });

  it('does not notify when the open succeeds', async () => {
    openDatabase.mockReturnValue(healthyConnection());
    const { getGlobalDb, getProjectDb, setDbOpenFailureNotifier } = await freshDatabaseModule();
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);

    getGlobalDb();
    getProjectDb('project-1');

    expect(notifier).not.toHaveBeenCalled();
  });

  type DatabaseModule = Awaited<ReturnType<typeof freshDatabaseModule>>;

  const everyStage: Array<{ label: string; arrange: (originalError: Error) => void; open: (databaseModule: DatabaseModule) => unknown }> = [
    {
      label: 'global open',
      arrange: (originalError) => { openDatabase.mockImplementationOnce(() => { throw originalError; }); },
      open: (databaseModule) => databaseModule.getGlobalDb(),
    },
    {
      label: 'global pragma',
      arrange: (originalError) => { openDatabase.mockReturnValueOnce(connectionFailingPragma(originalError)); },
      open: (databaseModule) => databaseModule.getGlobalDb(),
    },
    {
      label: 'global migrate',
      arrange: (originalError) => {
        openDatabase.mockReturnValueOnce(healthyConnection());
        runGlobalMigrationsMock.mockImplementationOnce(() => { throw originalError; });
      },
      open: (databaseModule) => databaseModule.getGlobalDb(),
    },
    {
      label: 'project open',
      arrange: (originalError) => { openDatabase.mockImplementationOnce(() => { throw originalError; }); },
      open: (databaseModule) => databaseModule.getProjectDb('project-1'),
    },
    {
      label: 'project pragma',
      arrange: (originalError) => { openDatabase.mockReturnValueOnce(connectionFailingPragma(originalError)); },
      open: (databaseModule) => databaseModule.getProjectDb('project-1'),
    },
    {
      label: 'project migrate',
      arrange: (originalError) => {
        openDatabase.mockReturnValueOnce(healthyConnection());
        runProjectMigrationsMock.mockImplementationOnce(() => { throw originalError; });
      },
      open: (databaseModule) => databaseModule.getProjectDb('project-1'),
    },
    {
      label: 'project initialize',
      // The initializer every case installs throws the original error, and only this stage reaches it.
      arrange: () => { openDatabase.mockReturnValueOnce(healthyConnection()); },
      open: (databaseModule) => databaseModule.getProjectDb('project-1'),
    },
  ];

  it.each(everyStage)('a notifier that throws does not replace the original error: $label', async ({ arrange, open }) => {
    const originalError = new Error('original failure');
    const databaseModule = await freshDatabaseModule();
    const notifier = vi.fn(() => { throw new Error('notifier exploded'); });
    databaseModule.setDbOpenFailureNotifier(notifier);
    databaseModule.setProjectDbInitializer(() => { throw originalError; });
    arrange(originalError);

    let thrown: unknown;
    try { open(databaseModule); } catch (error) { thrown = error; }

    expect(thrown).toBe(originalError);
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error and still notifies once when closing the broken handle throws', async () => {
    const pragmaError = new Error('disk I/O error');
    const broken = connectionFailingPragma(pragmaError);
    broken.close.mockImplementation(() => { throw new Error('close exploded'); });
    openDatabase.mockReturnValueOnce(broken);
    const { getGlobalDb, setDbOpenFailureNotifier } = await freshDatabaseModule();
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);

    let thrown: unknown;
    try { getGlobalDb(); } catch (error) { thrown = error; }

    expect(thrown).toBe(pragmaError);
    expect(broken.close).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith(pragmaError, { database: 'global', stage: 'pragma' });
  });

  it('setting the notifier to null stops notification', async () => {
    const openError = new Error('open failed');
    openDatabase.mockImplementation(() => { throw openError; });
    const { getGlobalDb, setDbOpenFailureNotifier } = await freshDatabaseModule();
    const notifier = vi.fn();
    setDbOpenFailureNotifier(notifier);
    setDbOpenFailureNotifier(null);

    expect(() => getGlobalDb()).toThrow(openError);
    expect(notifier).not.toHaveBeenCalled();
  });
});
