import { PostgresAdapter, sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { Database } from './schema.js';

// Only portable column types (text, integer) so the same migrations run on SQLite and Postgres.
// Keys are sorted as strings. The next key must be `003_...`; use 3-digit prefixes from here on.
const migrations: Record<string, Migration> = {
  '0001_init': {
    async up(db: Kysely<any>) {
      await db.schema.createTable('teams')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('invite_code_hash', 'text', (c) => c.notNull().unique())
        .addColumn('invite_expires_at', 'text', (c) => c.notNull())
        .addColumn('invite_revoked', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('repo_provider', 'text', (c) => c.notNull())
        .addColumn('repo_slug', 'text')
        .addColumn('default_branch', 'text', (c) => c.notNull())
        .addColumn('orchestrator_agent_id', 'text')
        .addColumn('created_by_member', 'text', (c) => c.notNull())
        .addColumn('creator_agent_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema.createTable('agents')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('team_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('member', 'text', (c) => c.notNull())
        .addColumn('tool', 'text', (c) => c.notNull())
        .addColumn('api_key_hash', 'text', (c) => c.notNull().unique())
        .addColumn('last_seen_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('agents_team_name_unique', ['team_id', 'name'])
        .execute();

      await db.schema.createTable('messages')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('team_id', 'text', (c) => c.notNull())
        .addColumn('from_agent_id', 'text', (c) => c.notNull())
        .addColumn('to_agent_id', 'text')
        .addColumn('from_role', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('messages_team_idx').on('messages').columns(['team_id', 'id']).execute();

      await db.schema.createTable('message_reads')
        .addColumn('message_id', 'text', (c) => c.notNull())
        .addColumn('agent_id', 'text', (c) => c.notNull())
        .addColumn('read_at', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('message_reads_pk', ['message_id', 'agent_id'])
        .execute();

      await db.schema.createTable('tasks')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('team_id', 'text', (c) => c.notNull())
        .addColumn('number', 'integer', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('assignee_agent_id', 'text')
        .addColumn('branch', 'text')
        .addColumn('summary', 'text')
        .addColumn('created_by_agent_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('tasks_team_number_unique', ['team_id', 'number'])
        .execute();

      await db.schema.createTable('claims')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('team_id', 'text', (c) => c.notNull())
        .addColumn('agent_id', 'text', (c) => c.notNull())
        .addColumn('glob', 'text', (c) => c.notNull())
        .addColumn('exclusive', 'integer', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('claims_team_expiry_idx').on('claims').columns(['team_id', 'expires_at']).execute();

      await db.schema.createTable('commits')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('team_id', 'text', (c) => c.notNull())
        .addColumn('agent_id', 'text', (c) => c.notNull())
        .addColumn('sha', 'text', (c) => c.notNull())
        .addColumn('branch', 'text', (c) => c.notNull())
        .addColumn('message', 'text', (c) => c.notNull())
        .addColumn('files_json', 'text', (c) => c.notNull())
        .addColumn('insertions', 'integer', (c) => c.notNull())
        .addColumn('deletions', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('commits_team_idx').on('commits').columns(['team_id', 'id']).execute();

      await db.schema.createTable('activity')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('team_id', 'text', (c) => c.notNull())
        .addColumn('agent_id', 'text')
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('data_json', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('activity_team_idx').on('activity').columns(['team_id', 'id']).execute();
    },
  },
  '002_git_layer': {
    async up(db: Kysely<any>) {
      await sql`DELETE FROM commits WHERE id NOT IN (SELECT MIN(id) FROM commits GROUP BY team_id, sha, branch)`.execute(db);
      await db.schema.createIndex('commits_team_sha_branch_unique').unique().on('commits')
        .columns(['team_id', 'sha', 'branch']).execute();
      await db.schema.alterTable('tasks').addColumn('merged_at', 'text').execute();
    },
  },
  '003_github_identity': {
    async up(db: Kysely<any>) {
      await db.schema.alterTable('agents').addColumn('github_login', 'text').execute();
    },
  },
  '004_github_id': {
    async up(db: Kysely<any>) {
      await db.schema.alterTable('agents').addColumn('github_id', 'integer').execute();
    },
  },
  '005_github_id_bigint': {
    async up(db: Kysely<any>) {
      // GitHub user ids can exceed int32. Postgres INTEGER is 32-bit; SQLite INTEGER is already 64-bit, so skip it there.
      // (pg returns int8 as a number: see the type parser in postgres.ts.)
      if (db.getExecutor().adapter instanceof PostgresAdapter) {
        await sql`ALTER TABLE agents ALTER COLUMN github_id TYPE bigint`.execute(db);
      }
    },
  },
  '006_replication': {
    // Bookkeeping for the git transport's op-log replay. Created on both dialects (portable types) but only
    // the CLI's SQLite replicas write to them.
    async up(db: Kysely<any>) {
      await db.schema.createTable('agent_keys')
        .addColumn('agent_id', 'text', (c) => c.primaryKey())
        .addColumn('team_id', 'text', (c) => c.notNull())
        .addColumn('public_key', 'text', (c) => c.notNull())
        .addColumn('registered_op_id', 'text', (c) => c.notNull())
        .execute();

      await db.schema.createTable('applied_ops')
        .addColumn('op_id', 'text', (c) => c.primaryKey())
        .addColumn('ts', 'text')
        .addColumn('agent', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('error', 'text')
        .addColumn('hash', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('applied_ops_order_idx').on('applied_ops').columns(['ts', 'agent', 'op_id']).execute();

      await db.schema.createTable('replica_state')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .execute();

      await db.schema.createTable('replica_notices')
        .addColumn('op_id', 'text', (c) => c.primaryKey())
        .addColumn('agent_id', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('delivered_at', 'text')
        .execute();
      await db.schema.createIndex('replica_notices_agent_idx').on('replica_notices').columns(['agent_id', 'op_id']).execute();
    },
  },
  '007_replication_v2': {
    // Replay hardening (Task 5 review rounds 1-2):
    // - applied_ops keyed by (agent, op_id, hash): op identity is (agent, id); equivocation losers get their own row.
    //   A replica that already replayed under 006 used the old row-id scheme, so its view is flagged for a rebuild.
    // - replica_notices keyed by (agent_id, op_id).
    // - agent_key_pins / team_meta_pins: local trust-on-first-use pins that rebuilds never touch.
    // - commits are unique per (team, agent, sha, branch): each agent's record stands on its own.
    async up(db: Kysely<any>) {
      const evaluated = await db.selectFrom('applied_ops').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
      await db.schema.dropTable('applied_ops').execute();
      await db.schema.createTable('applied_ops')
        .addColumn('agent', 'text', (c) => c.notNull())
        .addColumn('op_id', 'text', (c) => c.notNull())
        .addColumn('hash', 'text', (c) => c.notNull())
        .addColumn('ts', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('error', 'text')
        .addPrimaryKeyConstraint('applied_ops_pk', ['agent', 'op_id', 'hash'])
        .execute();
      await db.schema.createIndex('applied_ops_order_idx').on('applied_ops').columns(['ts', 'agent', 'op_id']).execute();
      await db.schema.createIndex('applied_ops_id_idx').on('applied_ops').columns(['op_id']).execute();
      if (Number(evaluated?.n ?? 0) > 0) {
        await db.insertInto('replica_state').values({ key: 'needs_rebuild', value: '1' })
          .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: '1' })).execute();
      }

      const notices = await db.selectFrom('replica_notices').selectAll().execute();
      await db.schema.dropTable('replica_notices').execute();
      await db.schema.createTable('replica_notices')
        .addColumn('agent_id', 'text', (c) => c.notNull())
        .addColumn('op_id', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('delivered_at', 'text')
        .addPrimaryKeyConstraint('replica_notices_pk', ['agent_id', 'op_id'])
        .execute();
      if (notices.length > 0) await db.insertInto('replica_notices').values(notices).execute();

      await db.schema.createTable('agent_key_pins')
        .addColumn('agent_id', 'text', (c) => c.primaryKey())
        .addColumn('public_key', 'text', (c) => c.notNull())
        .addColumn('pinned_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createTable('team_meta_pins')
        .addColumn('team_id', 'text', (c) => c.primaryKey())
        .addColumn('meta_json', 'text', (c) => c.notNull())
        .addColumn('pinned_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema.dropIndex('commits_team_sha_branch_unique').execute();
      await db.schema.createIndex('commits_team_agent_sha_branch_unique').unique().on('commits')
        .columns(['team_id', 'agent_id', 'sha', 'branch']).execute();
    },
  },
};

class InCodeMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

/** Migrates up to and including the named migration (used to test upgrade paths). */
export async function migrateTo(db: Kysely<Database>, name: string): Promise<void> {
  const { error } = await new Migrator({ db, provider: new InCodeMigrationProvider() }).migrateTo(name);
  if (error) throw error instanceof Error ? error : new Error(String(error));
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error } = await new Migrator({ db, provider: new InCodeMigrationProvider() }).migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
}
