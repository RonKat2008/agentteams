import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { Database } from './schema.js';

// Only portable column types (text, integer) so the same migrations run on SQLite and Postgres.
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
};

class InCodeMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error } = await new Migrator({ db, provider: new InCodeMigrationProvider() }).migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
}
